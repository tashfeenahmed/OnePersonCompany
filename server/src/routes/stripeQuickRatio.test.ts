import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, upsertPlugin, writeStripeSubscriptions } from "../db.ts";
import { stripeRoutes } from "./stripe.ts";

/*
  THE QUICK RATIO the /api/stripe document publishes per churn row: new MRR
  over (new MRR + churned MRR) for the window — the health figure ChartMogul
  and Baremetrics lead with. These pin the ENDPOINT's value, not just the
  client card that reads it, because the whole point of the field is that it
  is exact over the window's own movement while `ratePct` is approximate over
  a reconstructed book.
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
  currency: "usd",
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

async function churnRow(days: number) {
  const doc = (await (await stripeRoutes.request(`/?days=${days}`)).json()) as {
    churn: { days: number; currency: string; newMrr: number; churnedMrr: number; quickRatio: number | null }[];
  };
  const row = doc.churn.find((r) => r.days === 30);
  assert.ok(row, "the 30-day churn row is in the document");
  return row;
}

test("the churn row publishes the quick ratio over the window's own movement", async () => {
  const account = fixture("ratio");
  writeStripeSubscriptions([
    /* 100/month of standing book, older than every window. */
    sub(account, "qr_standing", "active", 100, 200, null, 10000),
    /* 160 arrived this month. */
    sub(account, "qr_new", "active", 160, 10, null, 16000),
    /* 40 left this month, from before the window opened. */
    sub(account, "qr_lost", "canceled", 40, 300, 5, 4000),
  ]);
  const row = await churnRow(30);
  assert.equal(row.newMrr, 160);
  assert.equal(row.churnedMrr, 40);
  /* 160 / (160 + 40) = 0.8 — the benchmark line, exactly. */
  assert.equal(row.quickRatio, 0.8);
});

test("revenue that arrived and churned inside the window counts as lost, not gained", async () => {
  const account = fixture("both");
  writeStripeSubscriptions([
    sub(account, "qr_inout", "canceled", 50, 10, 2, 5000),
  ]);
  /* `newMrr` counts subscriptions STILL BILLING, so this reads 0/50 — the
     conservative side. Booking gone revenue as gained would report 0.5 and
     flatter a book that kept none of it. */
  const row = await churnRow(30);
  assert.equal(row.newMrr, 0);
  assert.equal(row.churnedMrr, 50);
  assert.equal(row.quickRatio, 0);
});

test("churn with no new revenue reads 0, the worst honest figure", async () => {
  const account = fixture("zero");
  writeStripeSubscriptions([
    sub(account, "qr_standing2", "active", 100, 200, null, 10000),
    sub(account, "qr_onlyloss", "canceled", 30, 300, 4, 3000),
  ]);
  assert.equal((await churnRow(30)).quickRatio, 0);
});

test("growth with no churn reads 1.00: the best the window can report", async () => {
  const account = fixture("one");
  writeStripeSubscriptions([
    sub(account, "qr_quiet", "active", 100, 200, null, 10000),
    sub(account, "qr_growth", "active", 20, 3, null, 2000),
  ]);
  /* gained 20, lost 0 → 1.00: nothing left the book in the window. */
  assert.equal((await churnRow(30)).quickRatio, 1);
});
