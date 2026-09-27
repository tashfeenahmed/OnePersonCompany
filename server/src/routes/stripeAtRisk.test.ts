import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, upsertPlugin, writeStripeSubscriptions } from "../db.ts";
import { stripeRoutes } from "./stripe.ts";

/*
  AT-RISK MRR the /api/stripe document publishes (ChartMogul, ProfitWell,
  Baremetrics): the monthly value of past-due subscriptions — money that is
  still contracted and currently failing to collect. The count already exists
  as `subscriptions.pastDue`; this is the figure that says what it is WORTH,
  and the one that decides whether an afternoon of recovery emails pays.

  Past due is neither MRR (billing and failing) nor churn (not cancelled),
  and it is not `pendingCancellation` (a decision, not a declined card). The
  three must never be summed together, so they stay three separate fields.
*/

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function fixture(id: string) {
  db.exec("DELETE FROM stripe_subscriptions");
  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", `stripe-ar-${id}`);
  return account;
}
const sub = (
  currency: string,
  account: number,
  id: string,
  status: string,
  monthlyUsd: number,
) => ({
  accountId: account,
  accountLabel: "acc",
  id,
  status,
  currency,
  monthlyUsd,
  listedMonthlyUsd: monthlyUsd,
  interval: "month",
  intervalCount: 1,
  product: "Pro",
  plan: "Pro",
  createdAt: day(200),
  endedAt: null,
  cancelAtPeriodEnd: false,
  cancelAt: null,
  trialStart: null,
  trialEnd: null,
  reason: null,
  paidCents: 1000,
});

async function doc() {
  return (await (await stripeRoutes.request("/?days=30")).json()) as {
    atRisk: { subscriptions: number; mrr: { currency: string; amount: number }[]; note: string };
  };
}

test("at-risk MRR sums past-due subscriptions per currency", async () => {
  const account = fixture("sum");
  writeStripeSubscriptions([
    sub("usd", account, "ar_a", "past_due", 29),
    sub("usd", account, "ar_b", "past_due", 49),
    sub("usd", account, "ar_ok", "active", 100),
    sub("usd", account, "ar_trial", "trialing", 20),
    /* A pending cancellation is NOT at risk: a decision, not a declined card. */
    { ...sub("usd", account, "ar_cancelling", "active", 90), cancelAtPeriodEnd: true },
  ]);
  const body = await doc();
  assert.equal(body.atRisk.subscriptions, 2);
  assert.equal(body.atRisk.mrr.length, 1);
  assert.equal(body.atRisk.mrr[0]!.currency, "USD");
  assert.equal(body.atRisk.mrr[0]!.amount, 78);
  assert.match(body.atRisk.note, /past-due/);
});

test("currencies stay apart and an empty book is a zero, not a null", async () => {
  const account = fixture("fx");
  writeStripeSubscriptions([
    sub("usd", account, "ar_usd", "past_due", 30),
    sub("eur", account, "ar_eur", "past_due", 25),
    sub("eur", account, "ar_eur2", "past_due", 15),
  ]);
  const body = await doc();
  assert.equal(body.atRisk.subscriptions, 3);
  const by = Object.fromEntries(body.atRisk.mrr.map((r) => [r.currency, r.amount]));
  assert.equal(by.USD, 30);
  assert.equal(by.EUR, 40);
});

test("nothing past due reads zero subscriptions and no currency rows", async () => {
  const account = fixture("none");
  writeStripeSubscriptions([sub("usd", account, "ar_healthy", "active", 50)]);
  const body = await doc();
  assert.equal(body.atRisk.subscriptions, 0);
  assert.deepEqual(body.atRisk.mrr, []);
});
