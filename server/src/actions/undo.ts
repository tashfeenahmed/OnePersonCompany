import { randomUUID } from "node:crypto";
import { db } from "../db.ts";

// Only local disposition fields can be restored. Credentials, content, incident
// recovery and measurements are deliberately outside this capability.
const targets = {
  alert: { table: "alert_events", keys: ["id"], fields: ["acknowledged_at"] },
  commitment: { table: "people_commitments", keys: ["id"], fields: ["status", "decided_at"] },
  triage: { table: "mailflow_triage", keys: ["account_id", "thread_id"], fields: ["done_at", "snoozed_until"] },
  inbox: { table: "action_inbox_state", keys: ["id"], fields: ["resolved_at", "snoozed_until"] },
} as const;
type Target = keyof typeof targets;
type Value = string | number | null;
type Snapshot = Record<string, Value> | null;
export type UndoReceipt = { token: string; expiresAt: number };
export class UndoError extends Error {
  status: 404 | 409 | 410;
  constructor(message: string, status: 404 | 409 | 410) { super(message); this.status = status; }
}
function read(target: Target, keys: Value[]): Snapshot {
  const spec = targets[target];
  return db.prepare(`SELECT ${spec.fields.join(",")} FROM ${spec.table} WHERE ${spec.keys.map(k => `${k} = ?`).join(" AND ")}`).get(...keys) as Snapshot ?? null;
}
/** Call inside the same transaction as the source verb. */
export function undoable<T>(target: Target, keys: Value[], mutate: () => T): { result: T; undo: UndoReceipt | null } {
  const before = read(target, keys);
  const result = mutate();
  const after = read(target, keys);
  if (JSON.stringify(before) === JSON.stringify(after)) return { result, undo: null };
  const receipt = { token: randomUUID(), expiresAt: Date.now() + 30_000 };
  db.prepare("DELETE FROM action_undo WHERE expires_at < ?").run(Date.now() - 86_400_000);
  db.prepare("INSERT INTO action_undo (token, target, row_keys, before_state, after_state, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(receipt.token, target, JSON.stringify(keys), JSON.stringify(before), JSON.stringify(after), receipt.expiresAt);
  return { result, undo: receipt };
}
export function undoAction(token: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const receipt = db.prepare("SELECT * FROM action_undo WHERE token = ?").get(token) as { target: Target; row_keys: string; before_state: string; after_state: string; expires_at: number; used: number } | undefined;
    if (!receipt) throw new UndoError("This Undo is no longer available.", 404);
    if (receipt.used) { db.exec("COMMIT"); return; }
    if (receipt.expires_at < Date.now()) throw new UndoError("The Undo period has ended.", 410);
    const spec = targets[receipt.target];
    const keys = JSON.parse(receipt.row_keys) as Value[];
    const current = read(receipt.target, keys);
    if (JSON.stringify(current) !== receipt.after_state) throw new UndoError("This item changed again. Refresh to see its current state.", 409);
    const before = JSON.parse(receipt.before_state) as Snapshot;
    const where = spec.keys.map(k => `${k} = ?`).join(" AND ");
    if (before) db.prepare(`UPDATE ${spec.table} SET ${spec.fields.map(f => `${f} = ?`).join(",")} WHERE ${where}`).run(...spec.fields.map(f => before[f]!), ...keys);
    else db.prepare(`DELETE FROM ${spec.table} WHERE ${where}`).run(...keys);
    db.prepare("UPDATE action_undo SET used = 1 WHERE token = ?").run(token);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
