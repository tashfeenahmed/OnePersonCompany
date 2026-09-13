import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, upsertPlugin } from "../../db.ts";
import { fromDoc } from "../../shared/metrics-address.ts";
import { captureEventContext, eventContext, recoverEventContext, recoverSavedEventContexts } from "./event-context.ts";
import { evaluateAll, readRule, ruleUrl } from "./engine.ts";
import { alertRoutes } from "./alerts-routes.ts";
import { dashboardAlerts } from "./dashboard-alerts.ts";
import { deleteRule, event, events, insertEvent, insertRule, updateRule, writeSnapshot } from "./store.ts";

const make = () => insertRule({ name: "Crash rate rose against last week", skill: "stability", view: "default", params: { days: 30 }, path: "alerting.worstCrashRate", op: "rose_by_pct", threshold: 25, windowMinutes: 10080, ventureId: null, enabled: true, cooldownMinutes: 0 });
const report = (app: string, state: string, detail: string | null = null) => ({ store: "play", app, report: "reporting/crashRateMetricSet", state, detail });
const missing = {
  alerting: { worstCrashRate: null, worstCrashRateApp: null, crashCount: 8 },
  rates: [{ store: "play", app: "co.sample.chat", metric: "anrRate", window: 0.05 }],
  readiness: [
    report("co.sample.chat", "present"),
    report("co.sample.notes", "empty"),
    report("co.unknown.app", "error", "The operation was aborted due to timeout"),
    { ...report("anr-only", "error"), report: "reporting/anrRateMetricSet" },
    { ...report("123", "processing"), store: "appstore", report: "analytics/App Crashes" },
  ],
};
const measured = (app = "co.sample.chat", value = 0.02) => ({ alerting: { worstCrashRate: value, worstCrashRateApp: { store: "play", app } } });

upsertPlugin("appstore", false, null);
const accountId = insertAccount("appstore", "Test");
db.prepare(`INSERT INTO appstore_apps (account_id, account_label, app_id, bundle_id, name, seen_at) VALUES (?, 'Test', '1', 'co.sample.chat', 'Sample Chat', '2026-01-01')`).run(accountId);
db.prepare(`INSERT INTO appstore_apps (account_id, account_label, app_id, bundle_id, name, seen_at) VALUES (?, 'Test', '2', 'co.sample.notes', 'Sample Notes', '2026-01-01')`).run(accountId);

test("null rates retain app names and per-app reasons, without confusing crash counts or ANRs with rates", async () => {
  const r = make();
  try {
    const read = await readRule(r, new Map([[ruleUrl(r), missing]]));
    assert.equal(read.ok, false);
    assert.equal(read.doc, missing);
    const context = captureEventContext(r, read.doc, true)!;
    assert.match(context.title, /data unavailable · 3 apps/);
    assert.match(context.summary!, /rise in crashes has not been established/);
    assert.deepEqual(context.apps.map(a => a.name).sort(), ["Sample Chat", "Sample Notes", "co.unknown.app"].sort());
    assert.match(context.apps.find(a => a.app === "co.sample.chat")!.reason!, /no usable crash rate/);
    assert.match(context.apps.find(a => a.app === "co.unknown.app")!.reason!, /timed out/);
    assert.equal(captureEventContext({ ...r, skill: "stripe" }, missing, true), null);
  } finally { deleteRule(r.id); }
});

test("app and store filters constrain identities even when the upstream readiness document is unfiltered", () => {
  const r = make();
  try {
    const scoped = { ...r, params: JSON.stringify({ app: "co.sample.notes", store: "play", days: 30 }) };
    const context = captureEventContext(scoped, missing, true)!;
    assert.equal(context.apps.length, 1);
    assert.match(context.title, /Sample Notes \(Android\)/);
    assert.equal(captureEventContext(scoped, measured(), false), null);
    const failedFetch = captureEventContext(r, undefined, true)!;
    assert.deepEqual(failedFetch.apps, []);
    assert.match(failedFetch.title, /All monitored apps/);
  } finally { deleteRule(r.id); }
});

test("real readings name the measured app, including zero; stored identity survives rank and rule changes", () => {
  const r = make();
  try {
    const context = captureEventContext(r, measured(), false)!;
    assert.match(context.title, /^Sample Chat \(Android\)/);
    assert.equal(context.summary, null);
    assert.equal(captureEventContext(r, measured("co.sample.chat", 0), false)!.apps[0]!.name, "Sample Chat");
    const e = insertEvent({ ruleId: r.id, kind: "trip", observed: 0.02, previous: 0.01, message: "Rate doubled", context });
    writeSnapshot("stability", measured("co.sample.notes", 0.08), new Date().toISOString());
    const changed = updateRule(r.id, { name: "New rule", params: { app: "co.sample.notes" } })!;
    assert.equal(eventContext(e, changed)!.apps[0]!.name, "Sample Chat");
  } finally { deleteRule(r.id); db.prepare("DELETE FROM alert_snapshots WHERE skill = 'stability'").run(); }
});

test("automatic and manual checks persist context and expose it in both the event API and dashboard alerts", async t => {
  const r = make();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/skills")) return Response.json({ skills: [] });
    assert.equal(url, ruleUrl(r));
    return Response.json(missing);
  });
  try {
    const pass = await evaluateAll();
    assert.equal(pass.unreadable, 1);
    const e = event(pass.events[0]!)!;
    assert.ok(e.context);
    assert.equal(e.observed, null);
    const response = await alertRoutes.request(`/rules/${r.id}`);
    const doc = await response.json() as { events: { context: { title: string } }[] };
    assert.match(doc.events[0]!.context.title, /data unavailable/);
    const nav = (await dashboardAlerts()).alerts.find(a => a.id === `rule:${r.id}`)!;
    assert.match(nav.title, /data unavailable/);
    assert.match(nav.detail!, /Sample Chat/);
    const checked = await alertRoutes.request(`/rules/${r.id}/test`, { method: "POST" });
    assert.equal(checked.status, 200);
    assert.ok(events({ ruleId: r.id }).find(e => e.kind === "test")!.context);
  } finally { deleteRule(r.id); }
});

test("legacy recovery requires the same request, time and reading, and persists beyond snapshot retention", () => {
  const r = make();
  try {
    const e = insertEvent({ ruleId: r.id, kind: "unreadable", observed: null, previous: null, message: fromDoc(r, missing).error! });
    writeSnapshot("stability", missing, e.ts);
    assert.equal(recoverEventContext(e, r)!.apps.length, 3);
    assert.equal(recoverEventContext({ ...e, message: "HTTP 503" }, r)!.apps.length, 0);
    assert.equal(recoverEventContext(e, { ...r, params: '{"days":7}' })!.apps.length, 0);
    assert.equal(recoverEventContext(e, { ...r, updated_at: new Date(Date.parse(e.ts) + 1).toISOString() }), null);
    assert.equal(recoverEventContext({ ...e, ts: new Date(Date.parse(e.ts) + 6 * 60_000).toISOString() }, r)!.apps.length, 0);
    recoverSavedEventContexts();
    db.prepare("DELETE FROM alert_snapshots WHERE skill = 'stability'").run();
    assert.equal(eventContext(event(e.id)!, r)!.apps.length, 3);
    // A newer report cannot supply an older event's app identity.
    writeSnapshot("stability", measured("co.sample.notes"), new Date(Date.parse(e.ts) + 1).toISOString());
    assert.equal(recoverEventContext(e, r)!.apps.length, 0);
  } finally { deleteRule(r.id); db.prepare("DELETE FROM alert_snapshots WHERE skill = 'stability'").run(); }
});
