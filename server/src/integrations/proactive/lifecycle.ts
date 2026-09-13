import { db } from "../../db.ts";
import { COLLECT_MINUTES } from "../../config.ts";
import { clearIncidents, type RuleRow } from "./store.ts";
import type { Verdict } from "./engine.ts";

export type Pending = { since: string | null; hits: number; checkedAt: string | null };

/** Gaps and unknown checks cannot prove that a condition persisted. */
export function persistence(previous: Pending, failing: boolean | null, at: string,
  config: { minutes: number; checks: number; maxGapMinutes: number }): Pending & { ready: boolean } {
  if (failing !== true) return { since: null, hits: 0, checkedAt: at, ready: false };
  const gap = previous.checkedAt ? Date.parse(at) - Date.parse(previous.checkedAt) : Infinity;
  if (gap <= 0) return { ...previous, ready: false };
  const continuous = previous.since && gap <= config.maxGapMinutes * 60_000;
  const since = continuous ? previous.since! : at;
  const hits = continuous ? previous.hits + 1 : 1;
  return { since, hits, checkedAt: at, ready: hits >= config.checks && Date.parse(at) - Date.parse(since) >= config.minutes * 60_000 };
}

export function advanceIncident(r: RuleRow, verdict: Verdict | null, at: string): { ready: boolean; cleared: number } {
  let cleared = 0;
  if (verdict) {
    cleared += clearIncidents(r.id, "unreadable", at, "The metric can be read again.");
    if (!verdict.undecidable && !verdict.tripped)
      cleared += clearIncidents(r.id, "trip", at, verdict.message);
  }
  const pending = persistence({ since: r.pending_since ?? null, hits: r.pending_hits ?? 0, checkedAt: r.pending_checked_at ?? null },
    !verdict || verdict.undecidable ? null : verdict.tripped, at,
    { minutes: r.for_minutes ?? 0, checks: r.consecutive ?? 1, maxGapMinutes: Math.max(5, (COLLECT_MINUTES || 30) * 2.5) });
  db.prepare("UPDATE alert_rules SET pending_since = ?, pending_hits = ?, pending_checked_at = ? WHERE id = ?")
    .run(pending.since, pending.hits, pending.checkedAt, r.id);
  return { ready: pending.ready, cleared };
}
