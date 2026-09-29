import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, upsertPlugin, writeStripeSubscriptions } from "../db.ts";
import { stripeRoutes } from "./stripe.ts";

/*
  CHURN BY REASON on every churn row (Baremetrics Cancellation Insights,
  ChartMogul's churn-by-reason charts): Stripe stamps cancellation_details.
  reason on a cancellation when it has one, and this is the only place this
  box can see WHY money left, not just how much. The split covers exactly the
  real-churn population — the same rows churnedMrr counts, never the
  never-billed ones — and a null reason is its own `not_stated` bucket so the
  rows sum to churnedMrr instead of quietly under-reporting it.
*/

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function fixture(id: string) {
  db.exec("DELETE FROM stripe_subscriptions");
  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", `stripe-cr-${id}`);
  return account;
}
const sub = (
  account: number,
  id: string,
  patch: Record<string, unknown> = {},
) => ({
  accountId: account,
  accountLabel: "acc",
  id,
  status: "canceled",
  currency: "usd",
  monthlyUsd: 30,
  listedMonthlyUsd: 30,
  interval: "month",
  intervalCount: 1,
  product: "Pro",
  plan: "Pro",
  createdAt: day(200),
  endedAt: day(3),
  cancelAtPeriodEnd: false,
  cancelAt: null,
  trialStart: null,
  trialEnd: null,
  reason: null,
  paidCents: 1000,
  ...patch,
});

async function churnRows(): Promise<{
  days: number;
  churnedMrr: number;
  churnedSubs: number;
  byReason: { reason: string; mrr: number; subscriptions: number }[];
}[]> {
  const body = (await (await stripeRoutes.request("/?days=30")).json()) as {
    churn: ReturnType<typeof Object>[];
  };
  return body.churn as never;
}

test("a churned subscription's Stripe reason rides on the churn row", async () => {
  const account = fixture("basic");
  writeStripeSubscriptions([
    sub(account, "cr_disputed", { reason: "payment_disputed", monthlyUsd: 50 }),
    sub(account, "cr_paid", { reason: "cancellation_requested", monthlyUsd: 20 }),
  ]);
  const rows = await churnRows();
  const row = rows.find((r) => r.days === 30)!;
  assert.deepEqual(row.byReason, [
    { reason: "payment_disputed", mrr: 50, subscriptions: 1 },
    { reason: "cancellation_requested", mrr: 20, subscriptions: 1 },
  ]);
  const sumMrr = row.byReason.reduce((n, r) => n + r.mrr, 0);
  const sumSubs = row.byReason.reduce((n, r) => n + r.subscriptions, 0);
  assert.equal(sumMrr, row.churnedMrr, "the split sums to churned MRR");
  assert.equal(sumSubs, row.churnedSubs, "the split sums to churned subs");
});

test("a cancellation Stripe never got a reason for is not_stated, not dropped", async () => {
  const account = fixture("null");
  writeStripeSubscriptions([
    sub(account, "cr_silent", { monthlyUsd: 40 }),
    sub(account, "cr_stated", { reason: "payment_failed", monthlyUsd: 10 }),
  ]);
  const row = (await churnRows()).find((r) => r.days === 30)!;
  assert.deepEqual(row.byReason, [
    { reason: "not_stated", mrr: 40, subscriptions: 1 },
    { reason: "payment_failed", mrr: 10, subscriptions: 1 },
  ]);
});

test("never-billed cancellations stay out of the reason split", async () => {
  const account = fixture("notbilled");
  writeStripeSubscriptions([
    sub(account, "cr_trial", { reason: "cancellation_requested", paidCents: 0, trialStart: day(30) }),
    sub(account, "cr_real", { reason: "cancellation_requested", monthlyUsd: 25 }),
  ]);
  const row = (await churnRows()).find((r) => r.days === 30)!;
  assert.deepEqual(row.byReason, [{ reason: "cancellation_requested", mrr: 25, subscriptions: 1 }]);
});

test("still-billing subscriptions contribute no reason row", async () => {
  const account = fixture("live");
  writeStripeSubscriptions([
    sub(account, "cr_live", { status: "active", reason: null, endedAt: null }),
  ]);
  const rows = await churnRows();
  const row = rows.find((r) => r.days === 30)!;
  assert.deepEqual(row.byReason, []);
});
