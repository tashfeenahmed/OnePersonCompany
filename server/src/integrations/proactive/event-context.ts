import { appStoreApps, ventureRows } from "../../db.ts";
import { linkIndex } from "../ventures/links.ts";
import { fromDoc, paramsOf } from "../../shared/metrics-address.ts";
import { eventsMissingContext, rules, setEventContext, snapshotAtOrBefore, type EventRow, type RuleRow } from "./store.ts";
import type { AlertContext } from "../../../../shared/alertContext.ts";

type Address = Pick<RuleRow, "name" | "skill" | "view" | "params" | "path">;
type ObjectDoc = Record<string, unknown>;
const object = (value: unknown): ObjectDoc =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectDoc : {};
const list = (value: unknown): ObjectDoc[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const platform = (store: string) => store === "play" ? "Android" : store === "appstore" ? "iOS" : store;
const watchesCrashRate = (r: Address) => r.skill === "stability" && r.view === "default" && r.path === "alerting.worstCrashRate";

/** Names are labels only. Match saved provider IDs or explicit venture links;
 * never guess ownership from a similar package name. Unknown apps keep their ID. */
function appNamer() {
  const names = new Map<string, string>();
  for (const app of appStoreApps()) {
    if (!app.name) continue;
    names.set(`appstore:${app.app_id}`, app.name);
    if (app.bundle_id) names.set(`play:${app.bundle_id}`, app.name);
  }
  const ventures = new Map(ventureRows().map(v => [v.id, v.name]));
  for (const [store, plugin] of [["play", "playstore"], ["appstore", "appstore"]] as const) {
    for (const [app, ids] of linkIndex(plugin)) {
      if (ids.length !== 1) continue;
      const name = ventures.get(ids[0]!);
      if (name) names.set(`${store}:${app}`, name);
    }
  }
  return (store: string, app: string) => names.get(`${store}:${app}`) ?? app;
}

/** Keep the document even when its scalar is null: readiness explains WHICH
 * apps could not supply that measurement. Count/ANR reports are not crash rates. */
export function captureEventContext(r: Address, doc: unknown, unavailable: boolean): AlertContext | null {
  if (!watchesCrashRate(r)) return null;
  const data = object(doc);
  const params = paramsOf(r.params);
  const nameOf = appNamer();
  const inScope = (row: ObjectDoc) =>
    (!params.app || row.app === params.app) && (!params.store || row.store === params.store);
  const apps: AlertContext["apps"] = [];
  const add = (row: ObjectDoc, reason: string | null) => {
    const app = text(row.app), store = text(row.store);
    if (!app || !inScope(row) || apps.some(a => a.app === app && a.store === store)) return;
    apps.push({ app, store, name: nameOf(store, app), reason });
  };

  if (!unavailable) {
    add(object(object(data.alerting).worstCrashRateApp), null);
    if (!apps.length) return null;
    const app = apps[0]!;
    return { title: `${app.name} (${platform(app.store)}) · ${r.name}`, summary: null, apps };
  }

  for (const row of list(data.readiness)) {
    if (row.report !== "reporting/crashRateMetricSet") continue;
    const detail = text(row.detail);
    const reason = row.state === "empty" ? "No crash-rate readings were published."
      : row.state === "present" ? "The report arrived, but no usable crash rate was available in this window."
      : /timeout|timed out/i.test(detail) ? "The crash-rate request timed out."
      : detail || `Crash-rate report ${text(row.state) || "unavailable"}.`;
    add(row, reason);
  }
  for (const row of list(data.rates)) {
    if (row.metric === "crashRate" && row.window === null)
      add(row, "A window crash rate could not be calculated from the reported data.");
  }
  if (!apps.length && params.app) add({ app: params.app, store: params.store ?? "" }, "Crash-rate data could not be read.");
  apps.sort((a, b) => a.name.localeCompare(b.name) || a.store.localeCompare(b.store));
  const scope = apps.length === 1 ? `${apps[0]!.name}${apps[0]!.store ? ` (${platform(apps[0]!.store)})` : ""}`
    : apps.length ? `${apps.length} apps` : "All monitored apps";
  return {
    title: `Crash-rate data unavailable · ${scope}`,
    summary: "No usable crash rate was available for this check. A rise in crashes has not been established.",
    apps,
  };
}

/** Legacy events can only recover identities from the SAME evaluation pass,
 * with the same default request and the same observed value/error. Never use
 * today's report, an old snapshot from another pass, or a subsequently edited rule. */
export function recoverEventContext(e: EventRow, r: RuleRow): AlertContext | null {
  if (!watchesCrashRate(r) || r.updated_at > e.ts) return null;
  const params = paramsOf(r.params);
  const defaultRequest = Object.keys(params).every(k => k === "days") && (!params.days || Number(params.days) === 30);
  const snapshot = defaultRequest ? snapshotAtOrBefore(r.skill, e.ts) : null;
  if (snapshot && Date.parse(e.ts) - Date.parse(snapshot.ts) <= 5 * 60_000) {
    const reading = fromDoc(r, snapshot.doc);
    const matches = e.observed === null ? reading.error === e.message : reading.error === null && reading.value === e.observed;
    if (matches) return captureEventContext(r, snapshot.doc, e.observed === null);
  }
  if (e.observed !== null) return null;
  return {
    title: "Crash-rate data unavailable",
    summary: "This older event did not record app details, and no matching report remains. It does not establish a rise in crashes.",
    apps: [],
  };
}

export function eventContext(e: EventRow, r?: RuleRow): AlertContext | null {
  if (e.context) {
    try { return JSON.parse(e.context) as AlertContext; } catch { /* Old/corrupt context can still use a matching snapshot. */ }
  }
  return r ? recoverEventContext(e, r) : null;
}

export function recoverSavedEventContexts() {
  const byRule = new Map(rules().map(r => [r.id, r]));
  for (const e of eventsMissingContext("stability")) {
    const r = byRule.get(e.rule_id);
    const context = r ? recoverEventContext(e, r) : null;
    if (context) setEventContext(e.id, context);
  }
}
