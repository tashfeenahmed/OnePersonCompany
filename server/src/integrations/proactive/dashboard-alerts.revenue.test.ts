import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, upsertPlugin, writeStripeSubscriptions } from "../../db.ts";
import { dashboardAlerts } from "./dashboard-alerts.ts";

/*
  The dashboard navigation reads the Stripe document the same way it reads
  fleet, domains and uptime: past-due money and subscriptions ending soon
  surface as alerts, a never-connected Stripe account stays silent, and a
  connected account with a clean book stays silent too. Money is the one
  source Baremetrics-type tools alert on first; these pin that this board
  does not watch servers while revenue leaks.
*/

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() - n * DAY).toISOString();

const sub = (account: number, id: string, status: string, monthlyUsd: number, cancelAtPeriodEnd = false) => ({
  accountId: account,
  accountLabel: "acc",
  id,
  status,
  currency: "USD",
  monthlyUsd,
  listedMonthlyUsd: monthlyUsd,
  interval: "month",
  intervalCount: 1,
  product: "Pro",
  plan: "Pro",
  createdAt: day(200),
  endedAt: null,
  cancelAtPeriodEnd,
  cancelAt: cancelAtPeriodEnd ? day(-20) : null,
  trialStart: null,
  trialEnd: null,
  reason: null,
  paidCents: 1000,
});

test("past-due Stripe money reaches the dashboard navigation", async () => {
  db.exec("DELETE FROM stripe_subscriptions");
  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", "stripe-dash-arrears");
  db.prepare("UPDATE plugin_accounts SET connected = 1 WHERE id = ?").run(account);
  writeStripeSubscriptions([sub(account, "sub_dash_due", "past_due", 29)]);
  try {
    const doc = await dashboardAlerts();
    const a = doc.alerts.find((x) => x.id === "revenue:at-risk");
    assert.ok(a, `at-risk alert missing from ${doc.alerts.map((x) => x.id).join(",")}`);
    assert.match(a!.detail, /USD 29\.00/);
    assert.ok(!doc.alerts.some((x) => x.id === "source:revenue"));
  } finally {
    db.prepare("DELETE FROM plugin_accounts WHERE id = ?").run(account);
  }
});

test("a never-connected Stripe account is silence, not a revenue alert", async () => {
  db.exec("DELETE FROM stripe_subscriptions");
  upsertPlugin("stripe", false, null);
  const doc = await dashboardAlerts();
  assert.ok(!doc.alerts.some((x) => x.id.startsWith("revenue:")));
});
