import { db, ventureRows } from "../../db.ts";
import { ventureRevenue } from "../finance/attribution.ts";
import { ventureCosts } from "../finance/profit.ts";
import { shapeTotals } from "../finance/money.ts";
import { shiftDay } from "../../../../shared/workJournal.ts";
import { classifyDormancy, detectAnomaly, projectPace, type MetricSeries, type InsightsReport, type Baseline } from "../../../../shared/insights.ts";
import { insightSettings } from "./settings.ts";

export function importedSources(): MetricSeries[] {
  const sources = db.prepare("SELECT id, label, source, venture_id AS ventureId, metric, unit, observed_at AS observedAt, complete_through AS completeThrough FROM insight_sources ORDER BY id").all() as Omit<MetricSeries, "points">[];
  const rows = db.prepare("SELECT source_id, day, value FROM insight_points ORDER BY source_id, day").all() as { source_id: string; day: string; value: number | null }[];
  const points = new Map<string, MetricSeries["points"]>();
  for (const p of rows) { const list = points.get(p.source_id) ?? []; list.push({ day: p.day, value: p.value }); points.set(p.source_id, list); }
  return sources.map(s => ({ ...s, points: points.get(s.id) ?? [] }));
}

export async function readInsightSources(): Promise<{ series: MetricSeries[]; notes: string[] }> {
  const { MANIFESTS } = await import("../index.ts");
  const providers = MANIFESTS.filter(m => m.insightSources);
  const results = await Promise.allSettled(providers.map(m => Promise.resolve().then(() => m.insightSources!())));
  const series = importedSources(), notes: string[] = [];
  const ids = new Set(series.map(s => s.id));
  results.forEach((result, i) => {
    if (result.status === "rejected") { notes.push(`${providers[i]!.id}: ${String(result.reason)}`); return; }
    for (const source of result.value) {
      if (ids.has(source.id)) { notes.push(`Duplicate source ${source.id} was ignored.`); continue; }
      ids.add(source.id); series.push(source);
    }
  });
  return { series, notes };
}

export async function insightsReport(): Promise<InsightsReport> {
  const asOf = new Date().toISOString(), today = asOf.slice(0, 10), settings = insightSettings();
  const { series, notes } = await readInsightSources();
  const cut = shiftDay(today, -settings.dormantDays);
  const months = new Set<string>();
  for (let day = cut; day <= today; day = shiftDay(day, 1)) months.add(day.slice(0, 7));
  const work = new Map<string, number>();
  for (const row of db.prepare(`SELECT venture_id AS id, COUNT(*) AS n FROM (
    SELECT venture_id FROM work_journal WHERE day >= ? AND kind IN ('did','shipped')
    UNION ALL SELECT venture_id FROM board_cards WHERE updated_at >= ?
  ) WHERE venture_id IS NOT NULL GROUP BY venture_id`).all(cut, cut) as { id: string; n: number }[]) work.set(row.id, row.n);
  const dormancy = ventureRows().map(v => {
    const revenue = [...months].map(m => ventureRevenue(v, m));
    const costs = ventureCosts(v.id, today.slice(0, 7));
    return classifyDormancy({ id: v.id, name: v.name, recentWork: work.get(v.id) ?? 0,
      series: series.filter(s => s.ventureId === v.id), revenue: revenue.flatMap(r => [...r.runRate.map(m => m.amount), ...shapeTotals(r.net).amounts.map(m => m.amount)]),
      revenueUnknown: notes.length > 0 || revenue.some(r => r.unavailable.length > 0), costs: shapeTotals(costs.total).amounts, costsComplete: costs.unpricedLabels.length === 0 }, settings, today);
  });
  const dormant = dormancy.filter(v => v.status === "dormant"), amounts = new Map<string, number>();
  for (const v of dormant) for (const c of v.costs) amounts.set(c.currency, (amounts.get(c.currency) ?? 0) + c.amount);
  const states = new Map((db.prepare("SELECT source_id, baseline FROM insight_anomalies").all() as { source_id: string; baseline: string | null }[]).map(r => [r.source_id, r.baseline ? JSON.parse(r.baseline) as Baseline : null]));
  return { infrastructure: db.prepare("SELECT key, ts, title, source FROM activity_events WHERE kind = 'infrastructure' AND ts >= date(?, '-14 days') ORDER BY ts DESC LIMIT 25").all(asOf) as InsightsReport["infrastructure"], asOf, settings, sources: series.map(({ points: _points, ...s }) => s),
    pace: series.filter(s => s.metric === "mrr" || s.metric === "users").map(s => projectPace(s, today)), dormancy,
    dormantCosts: [...amounts].map(([currency, amount]) => ({ currency, amount })), dormantCostsComplete: dormant.every(v => v.costsComplete),
    anomalies: series.filter(s => ["pageviews", "signups", "custom"].includes(s.metric)).map(s => ({ id: s.id, label: s.label, source: s.source, ventureId: s.ventureId, result: detectAnomaly(s, settings, today, states.get(s.id)) })), notes };
}
