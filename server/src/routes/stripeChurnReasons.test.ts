import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, upsertPlugin, writeStripeSubscriptions } from "../db.ts";
import { stripeRoutes } from "./stripe.ts";

/*
  CHURN BY FEEDBACK on every churn row: what the churned customers said on
  Stripe's cancellation survey (cancellation_details.feedback), with a failed
  card or a dispute as its own `involuntary` bucket and no answer as
  `no_feedback`. The split covers exactly the real-churn population — the same
  rows churnedMrr counts, never the never-billed ones — so it sums to it.
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
  feedback: null,
  comment: null,
  paidCents: 1000,
  ...patch,
});

type Row = {
  days: number;
  churnedMrr: number;
  churnedSubs: number;
  byFeedback: { feedback: string; mrr: number; subscriptions: number }[];
  comments: { comment: string; feedback: string | null; endedAt: string }[];
};
async function row30(): Promise<Row> {
  const body = (await (await stripeRoutes.request("/?days=30")).json()) as { churn: Row[] };
  return body.churn.find((r) => r.days === 30)!;
}
const sums = (r: Row) => [
  Number(r.byFeedback.reduce((n, b) => n + b.mrr, 0).toFixed(2)),
  r.byFeedback.reduce((n, b) => n + b.subscriptions, 0),
];

test("churned MRR splits by survey feedback and sums to the churn totals", async () => {
  const account = fixture("basic");
  writeStripeSubscriptions([
    sub(account, "cf_price", { reason: "cancellation_requested", feedback: "too_expensive", monthlyUsd: 50 }),
    sub(account, "cf_price2", { reason: "cancellation_requested", feedback: "too_expensive", monthlyUsd: 9.99 }),
    sub(account, "cf_feat", { reason: "cancellation_requested", feedback: "missing_features", monthlyUsd: 20.01 }),
    sub(account, "cf_quiet", { reason: "cancellation_requested", monthlyUsd: 15 }),
    sub(account, "cf_card", { reason: "payment_failed", monthlyUsd: 10 }),
    sub(account, "cf_dispute", { reason: "payment_disputed", feedback: "other", monthlyUsd: 5 }),
    sub(account, "cf_old", { monthlyUsd: 3 }),
  ]);
  const row = await row30();
  assert.deepEqual(row.byFeedback, [
    { feedback: "too_expensive", mrr: 59.99, subscriptions: 2 },
    { feedback: "missing_features", mrr: 20.01, subscriptions: 1 },
    { feedback: "no_feedback", mrr: 18, subscriptions: 2 },
    { feedback: "involuntary", mrr: 15, subscriptions: 2 },
  ]);
  assert.deepEqual(sums(row), [row.churnedMrr, row.churnedSubs]);
});

test("never-billed and still-billing subscriptions stay out of the split", async () => {
  const account = fixture("notbilled");
  writeStripeSubscriptions([
    sub(account, "cf_trial", { feedback: "unused", paidCents: 0, trialStart: day(30) }),
    sub(account, "cf_live", { status: "active", endedAt: null, feedback: "too_complex", comment: "hmm" }),
    sub(account, "cf_real", { feedback: "unused", monthlyUsd: 25 }),
  ]);
  const row = await row30();
  assert.deepEqual(row.byFeedback, [{ feedback: "unused", mrr: 25, subscriptions: 1 }]);
  assert.deepEqual(row.comments, []);
});

test("the two newest survey comments ride on the row, newest first", async () => {
  const account = fixture("comments");
  writeStripeSubscriptions([
    sub(account, "cf_c1", { feedback: "too_complex", comment: "oldest", endedAt: day(20) }),
    sub(account, "cf_c2", { feedback: "low_quality", comment: "newest", endedAt: day(1) }),
    sub(account, "cf_c3", { comment: "middle", endedAt: day(5) }),
    sub(account, "cf_trialc", { comment: "never paid", paidCents: 0, trialStart: day(40), endedAt: day(0.5) }),
  ]);
  const row = await row30();
  assert.deepEqual(
    row.comments.map((c) => [c.comment, c.feedback]),
    [["newest", "low_quality"], ["middle", null]],
  );
});
