/**
 * A STORE AUDIT THE DAY AN APP IS RELEASED.
 *
 * An audit of an app still in App Store Connect's review queue has nothing to
 * read — Apple's public lookup does not know the app yet — so the audit says
 * "not released yet" and files nothing. The audit worth having is the first
 * one after release, and it should not depend on somebody remembering to ask.
 *
 * The App Store collector replaces an account's apps whole on every pass. It
 * reads `on_store` for each app BEFORE the replace and hands it here AFTER;
 * an app that went from not-on-store to on-store between two passes was just
 * released, and its venture gets exactly one ASO run. Once per release falls
 * out of the transition itself: the next pass sees on_store = 1 both sides.
 * A venture that already has an ASO run queued or running is left alone.
 */

import { db, ventureRows } from "../../db.ts";
import { insertRun, mintRunId } from "../runs/store.ts";
import { kindDef } from "../runs/kinds.ts";
import { appsForVenture } from "./aso.ts";

/** app id → on_store as the table held it before this pass's replace. */
export function onStoreSnapshot(accountId: number): Map<string, boolean> {
  const rows = db
    .prepare("SELECT app_id, on_store FROM appstore_apps WHERE account_id = ?")
    .all(accountId) as unknown as { app_id: string; on_store: number | null }[];
  return new Map(rows.map((r) => [r.app_id, r.on_store === 1]));
}

/** The app ids that were in the table as not-on-store and now are on it. */
export function releasedSince(before: Map<string, boolean>, after: { id: string; onStore: boolean }[]): string[] {
  return after.filter((a) => a.onStore && before.get(a.id) === false).map((a) => a.id);
}

/** Queue one ASO run per venture whose app was just released. Returns the run ids. */
export function queueReleaseAudits(appIds: string[]): string[] {
  if (!appIds.length) return [];
  const def = kindDef("aso");
  if (!def) return [];
  const queued: string[] = [];
  for (const v of ventureRows()) {
    const hit = appsForVenture(v).find((a) => a.store === "appstore" && appIds.includes(a.appId));
    if (!hit) continue;
    const open = db
      .prepare("SELECT 1 FROM agent_runs WHERE kind = 'aso' AND venture_id = ? AND status IN ('queued','running') LIMIT 1")
      .get(v.id);
    if (open) continue;
    const input: Record<string, string> = {};
    for (const spec of def.inputs) if (spec.default.trim()) input[spec.key] = spec.default.trim();
    const id = mintRunId();
    insertRun({ id, kind: "aso", ventureId: v.id, title: `${def.name} — ${v.name} (released)`, input });
    queued.push(id);
  }
  return queued;
}
