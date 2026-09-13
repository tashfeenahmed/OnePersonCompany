import { shiftDay, validDay } from "./workJournal.ts";

/** Provider-neutral, daily observations. Null and missing days are never zero. */
export type MetricSeries = {
  id: string;
  label: string;
  source: string;
  ventureId: string | null;
  metric: "mrr" | "users" | "signups" | "pageviews" | "custom";
  unit: string;
  points: { day: string; value: number | null }[];
  observedAt: string | null;
  completeThrough: string;
  unavailable?: string | null;
};
export type InsightSettings = {
  anomalyEnabled: boolean;
  baselineDays: number;
  minSamples: number;
  sensitivity: number;
  minChangePercent: number;
  minAbsoluteChange: number;
  dormantDays: number;
  dormantViews: number;
  dormantSignups: number;
  diskPercent: number;
  gpuBusyPercent: number;
};
export const INSIGHT_DEFAULTS: InsightSettings = {
  anomalyEnabled: true, baselineDays: 28, minSamples: 14, sensitivity: 3,
  minChangePercent: 30, minAbsoluteChange: 5, dormantDays: 28,
  dormantViews: 100, dormantSignups: 1, diskPercent: 85, gpuBusyPercent: 10,
};
export function dailyPoints(s: MetricSeries) {
  const days = new Map<string, number | null>();
  for (const p of s.points) if (validDay(p.day) && p.day <= s.completeThrough)
    days.set(p.day, typeof p.value === "number" && Number.isFinite(p.value) ? p.value : null);
  return [...days].sort(([a], [b]) => a.localeCompare(b)).flatMap(([day, value]) => value === null ? [] : [{ day, value }]);
}
export function seriesProblem(s: MetricSeries, today: string): string | null {
  if (s.unavailable) return s.unavailable;
  if (!s.observedAt || !Number.isFinite(Date.parse(s.observedAt)) || Date.parse(`${today}T00:00:00Z`) - Date.parse(s.observedAt) > 3 * 86400000) return "Source has not reported recently.";
  const latest = dailyPoints(s).at(-1);
  if (!validDay(s.completeThrough) || latest?.day !== s.completeThrough) return "The latest complete day has no measured value.";
  if (!latest || latest.day < shiftDay(today, -3)) return "No recent complete daily reading.";
  return null;
}
function regression(points: { day: string; value: number }[]) {
  const start = Date.parse(points[0]!.day);
  const xs = points.map(p => (Date.parse(p.day) - start) / 86400000);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const mean = points.reduce((a, p) => a + p.value, 0) / points.length;
  const denominator = xs.reduce((a, x) => a + (x - xMean) ** 2, 0);
  return denominator ? points.reduce((a, p, i) => a + (xs[i]! - xMean) * (p.value - mean), 0) / denominator : 0;
}
export type Pace = { id: string; label: string; ventureId: string | null; metric: MetricSeries["metric"]; unit: string; current: number | null; perWeek: number | null; projected: number | null; horizonDays: number; samples: number; from: string | null; through: string | null; reason: string | null; points: { day: string; value: number }[] };
export function projectPace(s: MetricSeries, today: string, horizonDays = 30): Pace {
  const points = dailyPoints(s).filter(p => p.day >= shiftDay(today, -29));
  const first = points[0], last = points.at(-1);
  let reason = seriesProblem(s, today);
  const span = first && last ? (Date.parse(last.day) - Date.parse(first.day)) / 86400000 + 1 : 0;
  if (!reason && (points.length < 14 || span < 14 || points.length / span < 0.75)) reason = "Needs at least 14 measured days with 75% coverage.";
  const slope = points.length > 1 ? regression(points) : 0;
  const recent = points.slice(-7);
  const recentSlope = recent.length > 1 ? regression(recent) : 0;
  if (!reason && slope * recentSlope < 0 && Math.abs(recentSlope) > Math.abs(slope) * 0.5) reason = "The recent trend reversed; a projection would be misleading.";
  return { id: s.id, label: s.label, ventureId: s.ventureId, metric: s.metric, unit: s.unit,
    current: last?.value ?? null, perWeek: reason ? null : slope * 7,
    projected: reason || !last ? null : Math.max(0, last.value + slope * horizonDays),
    horizonDays, samples: points.length, from: first?.day ?? null, through: last?.day ?? null, reason, points };
}
const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return (a[Math.floor((a.length - 1) / 2)]! + a[Math.floor(a.length / 2)]!) / 2; };
export type Baseline = { center: number; scale: number; low: number; high: number; samples: number; from: string; through: string };
export type Anomaly = { state: "warming" | "unavailable" | "normal" | "anomaly"; reason: string | null; day: string | null; value: number | null; baseline: Baseline | null };
export function detectAnomaly(s: MetricSeries, config: InsightSettings, today: string, held?: Baseline | null): Anomaly {
  const problem = seriesProblem(s, today);
  if (problem) return { state: "unavailable", reason: problem, day: null, value: null, baseline: null };
  const points = dailyPoints(s), latest = points.at(-1)!;
  const history = points.filter(p => p.day < latest.day && p.day >= shiftDay(latest.day, -config.baselineDays));
  if (!held && history.length < config.minSamples) return { state: "warming", reason: `${history.length}/${config.minSamples} baseline days collected.`, day: latest.day, value: latest.value, baseline: null };
  let baseline = held ?? null;
  if (!baseline) {
    const center = median(history.map(p => p.value));
    // Robust to one prior spike. A counting-noise floor also handles a flat baseline.
    const scale = Math.max(1, Math.sqrt(Math.abs(center)), median(history.map(p => Math.abs(p.value - center))) * 1.4826);
    const distance = Math.max(scale * config.sensitivity, Math.abs(center) * config.minChangePercent / 100, config.minAbsoluteChange);
    baseline = { center, scale, low: center - distance, high: center + distance, samples: history.length, from: history[0]!.day, through: history.at(-1)!.day };
  }
  return { state: latest.value < baseline.low || latest.value > baseline.high ? "anomaly" : "normal", reason: null, day: latest.day, value: latest.value, baseline };
}

export type Dormancy = { id: string; name: string; status: "active" | "dormant" | "unknown"; reasons: string[]; costs: { currency: string; amount: number }[]; costsComplete: boolean };
export function classifyDormancy(input: { id: string; name: string; recentWork: number; series: MetricSeries[]; revenue: number[]; revenueUnknown: boolean; costs: Dormancy["costs"]; costsComplete: boolean }, config: InsightSettings, today: string): Dormancy {
  const active: string[] = [], unknown: string[] = [];
  let measured = 0;
  if (input.recentWork) active.push(`${input.recentWork} work entries or board updates in ${config.dormantDays} days`);
  if (input.revenue.some(n => n > 0)) active.push("Reported revenue or recurring subscriptions");
  if (input.revenueUnknown) unknown.push("Revenue coverage is incomplete");
  for (const s of input.series.filter(s => s.metric === "pageviews" || s.metric === "signups")) {
    const problem = seriesProblem(s, today);
    const points = dailyPoints(s).filter(p => p.day >= shiftDay(today, -config.dormantDays));
    if (problem || points.length < Math.ceil(config.dormantDays * 0.75)) { unknown.push(`${s.label}: ${problem ?? "not enough complete days"}`); continue; }
    measured++;
    const n = points.reduce((sum, p) => sum + p.value, 0);
    const limit = s.metric === "pageviews" ? config.dormantViews : config.dormantSignups;
    if (n >= limit) active.push(`${s.label}: ${n.toLocaleString()} in ${config.dormantDays} days`);
    // Keep growing ventures visible even when their absolute traffic is small.
    const half = Math.floor(points.length / 2);
    const before = points.slice(0, half).reduce((sum, p) => sum + p.value, 0) / half;
    const after = points.slice(half).reduce((sum, p) => sum + p.value, 0) / (points.length - half);
    if (after >= before * 1.5 && after - before >= 2) active.push(`${s.label}: activity is growing`);
  }
  if (!measured) unknown.push("No complete traffic or signup history linked to this venture");
  return { id: input.id, name: input.name, status: active.length ? "active" : unknown.length ? "unknown" : "dormant",
    reasons: active.length ? active : unknown.length ? unknown : [`Below the configured activity limits with no tracked work or reported revenue in ${config.dormantDays} days`],
    costs: input.costs, costsComplete: input.costsComplete };
}

export type InsightsReport = { infrastructure: { key: string; ts: string; title: string; source: string }[]; asOf: string; settings: InsightSettings; sources: Omit<MetricSeries, "points">[]; pace: Pace[]; dormancy: Dormancy[]; dormantCosts: { currency: string; amount: number }[]; dormantCostsComplete: boolean; anomalies: { id: string; label: string; source: string; ventureId: string | null; result: Anomaly }[]; notes: string[] };
