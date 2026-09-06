/**
 * THE SECOND KEY-VALUE STORE, WITH ONE DOOR.
 *
 * `plugin_config` is where an owner's own settings live; it has an accessor,
 * a settings surface and validation. `runtime_settings` is the other one — the
 * box's own bookkeeping, which nobody types and no settings page should show:
 * the budget blob, the queue's pause flag, and the watermarks that stop a
 * daily walk running twice.
 *
 * IT HAD NO ACCESSOR AT ALL, and so the same twenty-word upsert was retyped in
 * four files with the key as a bare string literal in each. `rounds-last-due`
 * is written from TWO areas — the chief's own timer and the pipeline stage that
 * stands that timer down — and a typo in either is not a type error: it writes
 * a key nobody reads, the watermark never advances, and the round runs a second
 * time on the day the pipeline is switched off. The keys are constants here for
 * exactly that reason; a misspelling is now a compile error.
 *
 * READS NEVER THROW. Every value in here has a meaning for "not set yet" — no
 * budget overrides, not paused, never walked — and a box whose bookkeeping
 * table is missing should behave like a box that has never run, not fail to
 * boot.
 */
import { db } from "../db.ts";

/**
 * Every key this table holds. Add one here before writing it, so the next
 * reader can find every writer by finding the constant.
 */
export const RUNTIME_KEYS = {
  /** The global budget ceilings, as a JSON blob. See budgets.ts. */
  budgets: "budgets",
  /** Is the run queue held? Set from the runs area, read by the executor. */
  queuePaused: "queue-paused",
  /** The last local day the nightly pipeline walked. */
  pipelineLastDue: "pipeline-last-due",
  /** The last local day a chief round walked. WRITTEN FROM TWO PLACES — the
   *  chief's own timer and the pipeline stage that replaces it — which is the
   *  whole reason this file exists. */
  roundsLastDue: "rounds-last-due",
} as const;

export type RuntimeKey = (typeof RUNTIME_KEYS)[keyof typeof RUNTIME_KEYS];

/** The raw string, or null when it has never been written. */
export function readSetting(key: RuntimeKey): string | null {
  try {
    const row = db.prepare("SELECT value FROM runtime_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Write it, replacing whatever was there. The only upsert string on this box. */
export function writeSetting(key: RuntimeKey, value: string): void {
  db.prepare(
    "INSERT INTO runtime_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
}

/**
 * A JSON value, or the fallback.
 *
 * A row that will not parse is treated as absent rather than thrown: a
 * hand-edited blob costs the settings it held, not the boot.
 */
export function readJson<T>(key: RuntimeKey, fallback: T): T {
  const raw = readSetting(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: RuntimeKey, value: unknown): void {
  writeSetting(key, JSON.stringify(value));
}

/** A flag. Only the literal `"true"` is true, so a corrupted row reads as off
 *  — the safe direction for every flag in here. */
export function readFlag(key: RuntimeKey): boolean {
  return readSetting(key) === "true";
}

export function writeFlag(key: RuntimeKey, value: boolean): void {
  writeSetting(key, String(value));
}
