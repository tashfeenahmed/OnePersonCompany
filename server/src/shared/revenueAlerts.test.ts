/**
 * Revenue alerts for the dashboard navigation, computed by the repo-root
 * `shared/dashboardAlerts.ts` (the client consumes the same module through
 * its rollup). Baremetrics, ChartMogul and ProfitWell all treat dunning and
 * end-of-term as first-class alerts; the board here watched servers but
 * never money. The Stripe document already publishes `atRisk` (past-due MRR)
 * and `pendingCancellation.endingSoon`; this pins that those two numbers
 * become exactly two alerts, and that an empty or absent revenue section
 * raises nothing — a fresh account is not an incident.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { currentDashboardAlerts } from "../../../shared/dashboardAlerts.ts";

const mrr = (currency: string, amount: number) => ({ currency, amount });

test("past-due subscriptions raise one at-risk alert with the money", () => {
  const alerts = currentDashboardAlerts({
    revenue: { atRisk: { subscriptions: 2, mrr: [mrr("USD", 59.98)] }, endingSoon: { count: 0, mrr: [] } },
  });
  const a = alerts.find((x) => x.id === "revenue:at-risk");
  assert.ok(a);
  assert.equal(a!.severity, "warning");
  assert.match(a!.title, /2 subscriptions failing to pay/);
  assert.match(a!.detail, /USD 59\.98/);
  assert.deepEqual(a!.sources, ["stripe"]);
  assert.equal(a!.href, "/alerts");
  assert.ok(!alerts.some((x) => x.id === "revenue:ending-soon"));
});

test("one past-due subscription reads as one, not '1 subscriptions'", () => {
  const alerts = currentDashboardAlerts({
    revenue: { atRisk: { subscriptions: 1, mrr: [mrr("USD", 9.99)] }, endingSoon: { count: 1, mrr: [] } },
  });
  assert.ok(alerts.some((x) => x.title === "1 subscription failing to pay"));
  assert.ok(alerts.some((x) => x.title === "1 subscription end soon"));
});

test("subscriptions ending soon raise their own, separate alert", () => {
  const alerts = currentDashboardAlerts({
    revenue: { atRisk: { subscriptions: 0, mrr: [] }, endingSoon: { count: 1, mrr: [mrr("EUR", 49)] } },
  });
  const a = alerts.find((x) => x.id === "revenue:ending-soon");
  assert.ok(a);
  assert.match(a!.detail, /EUR 49\.00/);
  assert.ok(!alerts.some((x) => x.id === "revenue:at-risk"));
});

test("an empty book raises nothing, and no revenue input changes nothing", () => {
  const empty = currentDashboardAlerts({
    revenue: { atRisk: { subscriptions: 0, mrr: [] }, endingSoon: { count: 0, mrr: [] } },
  });
  assert.equal(empty.length, 0);
  assert.equal(currentDashboardAlerts({}).length, 0);
});

test("same-currency rows sum and different currencies never merge", () => {
  const alerts = currentDashboardAlerts({
    revenue: {
      atRisk: { subscriptions: 4, mrr: [mrr("USD", 10), mrr("USD", 5.5), mrr("EUR", 20)] },
      endingSoon: { count: 0, mrr: [] },
    },
  });
  const a = alerts.find((x) => x.id === "revenue:at-risk")!;
  assert.match(a.detail, /USD 15\.50/);
  assert.match(a.detail, /EUR 20\.00/);
  assert.ok(!/\b35\b/.test(a.detail));
});
