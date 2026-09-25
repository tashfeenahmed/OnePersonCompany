import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, upsertPlugin, writeStripeSubscriptions } from "../db.ts";
import { stripeRoutes } from "./stripe.ts";

/*
  THE QUICK RATIO the /api/stripe document publishes per churn row: MRR
  gained over MRR lost in the window (ChartMogul, Baremetrics), new versus
  churned only — plan changes leave no trace on the subscription. These pin
  the ENDPOINT's value, not just the client card that reads it.
*/

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function fixture(id: string) {
  /* Every test here rebuilds the whole book: churn windows read every row,
     so a previous test's ended subscription would sit inside this one. */
  db.exec("DELETE FROM stripe_subscriptions");
  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", `stripe-qr-${id}`);
  return account;
}
const sub = (
  currency: string,
  account: number,
  id: string,
  status: string,
  monthlyUsd: number,
  createdDays: number,
  endedDays: number | null,
  paidCents: number | null,
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
  createdAt: day(createdDays),
  endedAt: endedDays === null ? null : day(endedDays),
  cancelAtPeriodEnd: false,
  cancelAt: null,
  trialStart: null,
  trialEnd: null,
  reason: null,
  paidCents,
});

type Row = {
  days: number;
  currency: string;
  newMrr: number;
  churnedMrr: number;
  quickRatio: number | null;
  quickRatioInMrr: number;
  quickRatioOutMrr: number;
};
async function churnRows(days = 30) {
  const doc = (await (await stripeRoutes.request(`/?days=${days}`)).json()) as { churn: Row[] };
  return doc.churn.filter((r) => r.days === days);
}
async function churnRow(days = 30) {
  const row = (await churnRows(days))[0];
  assert.ok(row, "the churn row is in the document");
  return row;
}
type SubArgs = Parameters<typeof sub> extends [string, ...infer R] ? R : never;
const usd = (...a: SubArgs) => sub("usd", ...a);

test("the churn row publishes gained over lost for the window", async () => {
  const account = fixture("ratio");
  writeStripeSubscriptions([
    /* 100/month of standing book, older than every window. */
    usd(account, "qr_standing", "active", 100, 200, null, 10000),
    /* 160 arrived this month. */
    usd(account, "qr_new", "active", 160, 10, null, 16000),
    /* 40 left this month, from before the window opened. */
    usd(account, "qr_lost", "canceled", 40, 300, 5, 4000),
  ]);
  const row = await churnRow();
  assert.equal(row.newMrr, 160);
  assert.equal(row.churnedMrr, 40);
  assert.equal(row.quickRatioInMrr, 160);
  assert.equal(row.quickRatioOutMrr, 40);
  /* 160 / 40 = 4 — the healthy line, exactly. */
  assert.equal(row.quickRatio, 4);
});

test("revenue that arrived and churned inside the window is on both sides", async () => {
  const account = fixture("both");
  writeStripeSubscriptions([
    usd(account, "qr_standing", "active", 100, 200, null, 10000),
    usd(account, "qr_new", "active", 60, 10, null, 6000),
    usd(account, "qr_lost", "canceled", 20, 300, 5, 2000),
    usd(account, "qr_inout", "canceled", 50, 10, 2, 5000),
  ]);
  const row = await churnRow();
  /* newMrr is still-billing only; the ratio's gained side includes it. */
  assert.equal(row.newMrr, 60);
  assert.equal(row.quickRatioInMrr, 110);
  assert.equal(row.quickRatioOutMrr, 70);
  assert.equal(row.quickRatio, Number((110 / 70).toFixed(2)));
});

test("never-billed cancellations are on neither side", async () => {
  const account = fixture("unpaid");
  writeStripeSubscriptions([
    usd(account, "qr_standing", "active", 100, 200, null, 10000),
    usd(account, "qr_new", "active", 30, 10, null, 3000),
    usd(account, "qr_lost", "canceled", 10, 300, 5, 1000),
    /* Expired checkout created and ended in the window: never collected. */
    usd(account, "qr_expired", "incomplete_expired", 500, 6, 5, 0),
  ]);
  const row = await churnRow();
  assert.equal(row.quickRatioInMrr, 30);
  assert.equal(row.quickRatioOutMrr, 10);
  assert.equal(row.quickRatio, 3);
});

test("churn with no new revenue reads 0", async () => {
  const account = fixture("zero");
  writeStripeSubscriptions([
    usd(account, "qr_standing2", "active", 100, 200, null, 10000),
    usd(account, "qr_onlyloss", "canceled", 30, 300, 4, 3000),
  ]);
  assert.equal((await churnRow()).quickRatio, 0);
});

test("growth with no churn has no ratio, and its sides say it was growth", async () => {
  const account = fixture("one");
  writeStripeSubscriptions([
    usd(account, "qr_quiet", "active", 100, 200, null, 10000),
    usd(account, "qr_growth", "active", 20, 3, null, 2000),
  ]);
  const row = await churnRow();
  assert.equal(row.quickRatio, null);
  assert.equal(row.quickRatioInMrr, 20);
  assert.equal(row.quickRatioOutMrr, 0);
});

test("each currency gets its own ratio; nothing is blended", async () => {
  const account = fixture("fx");
  writeStripeSubscriptions([
    usd(account, "qr_usd_new", "active", 80, 10, null, 8000),
    usd(account, "qr_usd_lost", "canceled", 40, 300, 5, 4000),
    sub("eur", account, "qr_eur_new", "active", 10, 10, null, 1000),
    sub("eur", account, "qr_eur_lost", "canceled", 50, 300, 5, 5000),
  ]);
  const rows = await churnRows();
  const byCur = Object.fromEntries(rows.map((r) => [r.currency, r.quickRatio]));
  assert.equal(byCur.USD, 2);
  assert.equal(byCur.EUR, 0.2);
});
