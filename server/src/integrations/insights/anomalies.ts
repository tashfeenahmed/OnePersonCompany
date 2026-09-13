import { db, now } from "../../db.ts";
import { detectAnomaly, type Baseline, type MetricSeries } from "../../../../shared/insights.ts";
import { clearIncidents, hasActiveIncident, insertEvent, insertRule, markRule, rules } from "../proactive/store.ts";
import { readInsightSources } from "./data.ts";
import { insightSettings } from "./settings.ts";

/** One incident per stable source. Frozen bounds prevent an ongoing fault becoming its own normal. */
export async function evaluateAnomalies() {
  const config = insightSettings();
  if (!config.anomalyEnabled) return { raised: 0, cleared: 0, evaluated: 0, events: [] as number[] };
  const { series } = await readInsightSources();
  return evaluateSeriesAnomalies(series);
}
export function evaluateSeriesAnomalies(series: MetricSeries[]) {
  const config = insightSettings(), at = now(), today = at.slice(0, 10);
  let raised = 0, cleared = 0;
  let evaluated = 0;
  const events: number[] = [];
  const bySource = new Map(rules().filter(r => r.managed_source).map(r => [r.managed_source!, r]));
  for (const s of series.filter(s => ["pageviews", "signups", "custom"].includes(s.metric))) {
    let rule = bySource.get(s.id);
    // A deleted automatic watch is a deliberate opt-out, retained separately from its rule.
    const state = db.prepare("SELECT checked_day, baseline FROM insight_anomalies WHERE source_id = ?").get(s.id) as { checked_day: string | null; baseline: string | null } | undefined;
    if (state && !rule) continue;
    if (!rule) {
      rule = insertRule({ name: `${s.label} changed unusually`, skill: "insights", view: "default", params: { sourcePlugin: s.source }, path: "daily.value", op: "changed", threshold: null, windowMinutes: null, ventureId: s.ventureId, enabled: true, cooldownMinutes: 1440, seeded: true });
      db.prepare("UPDATE alert_rules SET managed_source = ? WHERE id = ?").run(s.id, rule.id);
    }
    if (!rule.enabled) continue;
    evaluated++;
    db.prepare("UPDATE alert_rules SET name = ?, venture_id = ?, params = ? WHERE id = ?")
      .run(`${s.label} changed unusually`, s.ventureId, JSON.stringify({ sourcePlugin: s.source }), rule.id);
    const held = state?.baseline ? JSON.parse(state.baseline) as Baseline : null;
    const result = detectAnomaly(s, config, today, held);
    markRule(rule.id, result.value, result.state === "unavailable" ? result.reason : null);
    // Missing data and baseline warm-up neither raise a numerical alarm nor claim recovery.
    if (!result.day || !result.baseline || result.state === "warming" || result.state === "unavailable") {
      if (!state) db.prepare("INSERT OR IGNORE INTO insight_anomalies (source_id, updated_at) VALUES (?, ?)").run(s.id, at);
      continue;
    }
    if (state?.checked_day && result.day <= state.checked_day) continue;
    if (result.state === "anomaly") {
      if (!hasActiveIncident(rule.id, "trip")) {
        const event = insertEvent({ ruleId: rule.id, kind: "trip", observed: result.value, previous: result.baseline.center,
          message: `${s.label}: ${result.value} ${s.unit} on ${result.day}; expected ${Math.max(0, result.baseline.low).toFixed(1)}–${result.baseline.high.toFixed(1)} from ${result.baseline.samples} prior days (${result.baseline.from}–${result.baseline.through}).` });
        raised++;
        events.push(event.id);
      }
    } else cleared += clearIncidents(rule.id, "trip", at, `${s.label} returned to its baseline range: ${result.value} ${s.unit} on ${result.day}.`);
    db.prepare(`INSERT INTO insight_anomalies (source_id, checked_day, baseline, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET checked_day = excluded.checked_day, baseline = excluded.baseline, updated_at = excluded.updated_at`)
      .run(s.id, result.day, result.state === "anomaly" ? JSON.stringify(result.baseline) : null, at);
  }
  return { raised, cleared, evaluated, events };
}
