import { db } from "../../db.ts";
import { INSIGHT_DEFAULTS, type InsightSettings } from "../../../../shared/insights.ts";
export function insightSettings(): InsightSettings {
  const row = db.prepare("SELECT settings FROM insight_preferences WHERE id = 1").get() as { settings: string } | undefined;
  return { ...INSIGHT_DEFAULTS, ...(row ? JSON.parse(row.settings) : {}) };
}
export function validateSettings(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Expected settings.";
  const ranges: Record<string, [number, number]> = { baselineDays: [14, 90], minSamples: [7, 90], sensitivity: [1.5, 10], minChangePercent: [0, 1000], minAbsoluteChange: [0, 1000000], dormantDays: [7, 90], dormantViews: [1, 100000000], dormantSignups: [1, 1000000], diskPercent: [1, 100], gpuBusyPercent: [1, 100] };
  for (const [key, v] of Object.entries(value)) {
    if (key === "anomalyEnabled") { if (typeof v !== "boolean") return "anomalyEnabled must be true or false."; continue; }
    const range = ranges[key];
    if (!range || typeof v !== "number" || !Number.isFinite(v) || v < range[0] || v > range[1]) return `${key} is not a valid setting.`;
    if (["baselineDays", "minSamples", "dormantDays"].includes(key) && !Number.isInteger(v)) return `${key} must be a whole number.`;
  }
  const next = { ...insightSettings(), ...value };
  return next.minSamples > next.baselineDays ? "Minimum samples cannot exceed baseline days." : null;
}
export function saveSettings(patch: Partial<InsightSettings>) {
  const settings = { ...insightSettings(), ...patch };
  db.prepare("INSERT INTO insight_preferences (id, settings) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings").run(JSON.stringify(settings));
  return settings;
}
