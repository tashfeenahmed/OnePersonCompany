import { db, now } from "../../db.ts";

export type InfrastructureSample = {
  key: string; source: string; label: string; ts: string;
  value: string | number | boolean | null; detail?: Record<string, unknown>;
  ventureId?: string | null; basis?: string;
  describe: (before: string | number | boolean, after: string | number | boolean) => string;
};

/** Persist each transition once. A first sample is a baseline; silence is never recovery. */
export function observeInfrastructure(sample: InfrastructureSample): boolean {
  if (!Number.isFinite(Date.parse(sample.ts)) || sample.value === null) return false;
  const before = db.prepare("SELECT value, ts, basis FROM infrastructure_state WHERE key = ?").get(sample.key) as { value: string; ts: string; basis: string } | undefined;
  if (before && before.ts >= sample.ts) return false;
  const value = JSON.stringify(sample.value), basis = sample.basis ?? "";
  const changed = before && before.basis === basis && before.value !== value;
  // A single SQL transaction keeps the watermark and its event inseparable.
  const nested = db.isTransaction;
  if (!nested) db.exec("BEGIN");
  try {
    if (changed) db.prepare(`INSERT OR IGNORE INTO activity_events (key,ts,exact,kind,venture_id,product,title,detail,source,found_at)
      VALUES (?,?,1,'infrastructure',?,?,?,?,?,?)`).run(`infrastructure:${sample.key}:${sample.ts}`, sample.ts, sample.ventureId ?? null, sample.label,
        `${sample.label}: ${sample.describe(JSON.parse(before.value), sample.value)}`,
        JSON.stringify({ ...sample.detail, before: JSON.parse(before.value), after: sample.value, previousObservedAt: before.ts, observedAt: sample.ts, basis, note: "Transition observed between successful samples; timestamp is when the change was detected." }), sample.source, now());
    db.prepare("INSERT INTO infrastructure_state (key,value,ts,basis) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,ts=excluded.ts,basis=excluded.basis")
      .run(sample.key, value, sample.ts, basis);
    if (!nested) db.exec("COMMIT");
  } catch (error) { if (!nested) db.exec("ROLLBACK"); throw error; }
  return !!changed;
}

/** A malformed observation should not turn a successful collection into a failed one. */
export function recordInfrastructure(samples: InfrastructureSample[]) {
  try { for (const sample of samples) observeInfrastructure(sample); }
  catch (error) { console.error("[activity] infrastructure observation failed", error); }
}
