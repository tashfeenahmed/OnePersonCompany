import { accountRows, db } from "../../db.ts";
import { observeInfrastructure } from "./infrastructure.ts";
import { recordWorkstationObservation } from "../security/infrastructure.ts";

/** Replay only observations newer than each entity's watermark; first install gets held history. */
export function backfillInfrastructure(): number {
  let inserted = 0;
  const uptime = db.prepare(`SELECT host, ts, ok, status FROM uptime_checks u
    WHERE ts >= datetime('now','-30 days') AND ts > COALESCE((SELECT ts FROM infrastructure_state WHERE key = 'uptime:' || u.host || ':ok'), '')
    ORDER BY ts`).all() as { host: string; ts: string; ok: number; status: number | null }[];
  for (const r of uptime) if (observeInfrastructure({ key: `uptime:${r.host}:ok`, label: r.host, source: "uptime", ts: r.ts, value: r.ok === 1, detail: { status: r.status }, describe: (_before, after) => after ? "site check recovered" : "site check failed" })) inserted++;
  const labels = new Map(accountRows("workstation").map(a => [a.id, a.label]));
  const workstations = db.prepare(`SELECT account_id, ts, reachable, gpu FROM workstation_state w
    WHERE ts >= datetime('now','-30 days') AND ts > COALESCE((SELECT ts FROM infrastructure_state WHERE key = 'workstation:' || w.account_id || ':reachable'), '')
    ORDER BY ts`).all() as { account_id: number; ts: string; reachable: number; gpu: string | null }[];
  for (const r of workstations) {
    let gpus = null;
    try { gpus = r.gpu ? JSON.parse(r.gpu) : null; } catch { /* Old unreadable GPU measurements remain unknown. */ }
    recordWorkstationObservation({ id: r.account_id, label: labels.get(r.account_id) ?? `Workstation ${r.account_id}`, reachable: r.reachable === 1, gpus }, r.ts);
  }
  return inserted;
}
