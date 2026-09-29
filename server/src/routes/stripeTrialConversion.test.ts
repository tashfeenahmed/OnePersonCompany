import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, upsertPlugin, writeStripeSubscriptions } from "../db.ts";
import { stripeRoutes } from "./stripe.ts";

/*
  TRIAL → PAID CONVERSION the /api/stripe document publishes — the figure
  ChartMogul and Baremetrics both treat as the clearest read on whether a
  product is worth paying for once the free look ends.

  THE COHORT is trials whose trial period ENDED inside the window. A trial
  still running belongs to no window; a trial that ended long ago belongs to
  an older one. Each member is judged by the same confirmed-zero rule churn
  uses — `paid_cents === 0` never paid, `null` counts as paid — so the two
  sections can never call the same subscription different things.
*/

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function fixture(id: string) {
  db.exec("DELETE FROM stripe_subscriptions");
  upsertPlugin("stripe", true, null);
  return insertAccount("stripe", `stripe-tc-${id}`);
}
const trial = (
  account: number,
  id: string,
  opts: {
    endedDaysAgo: number | null; // null → trial still running
    paidCents: number | null; // 0 → confirmed never paid
    monthlyUsd?: number;
    currency?: string;
    status?: string;
  },
) => ({
  accountId: account,
  accountLabel: "acc",
  id,
  status: opts.status ?? "active",
  currency: opts.currency ?? "usd",
  monthlyUsd: opts.monthlyUsd ?? 20,
  listedMonthlyUsd: opts.monthlyUsd ?? 20,
  interval: "month",
  intervalCount: 1,
  product: "Pro",
  plan: "Pro",
  createdAt: day(60),
  endedAt: null,
  cancelAtPeriodEnd: false,
  cancelAt: null,
  trialStart: day(opts.endedDaysAgo === null ? 3 : 30),
  trialEnd: opts.endedDaysAgo === null ? day(-3) : day(opts.endedDaysAgo),
  reason: null,
  paidCents: opts.paidCents,
});

async function doc() {
  return (await (await stripeRoutes.request("/?days=30")).json()) as {
    trialConversion: {
      inFlight: number;
      windows: {
        days: number;
        currency: string;
        cohort: number;
        converted: number;
        neverPaid: number;
        failing: number;
        ratePct: number;
        convertedMrr: number;
      }[];
      basis: string;
    };
  };
}

test("trials that ended in the window split into converted and never-paid", async () => {
  const a = fixture("split");
  writeStripeSubscriptions([
    trial(a, "tc_conv1", { endedDaysAgo: 5, paidCents: 2000 }),
    trial(a, "tc_conv2", { endedDaysAgo: 12, paidCents: 2000 }),
    trial(a, "tc_never", { endedDaysAgo: 3, paidCents: 0, status: "canceled" }),
  ]);
  const body = await doc();
  const row = body.trialConversion.windows.find((w) => w.days === 30 && w.currency === "USD")!;
  assert.ok(row, "30d USD row exists");
  assert.equal(row.cohort, 3);
  assert.equal(row.converted, 2);
  assert.equal(row.neverPaid, 1);
  assert.equal(row.ratePct, 66.7);
  assert.equal(row.convertedMrr, 40);
});

test("a trial still running is in flight, not in any cohort", async () => {
  const a = fixture("flight");
  writeStripeSubscriptions([
    trial(a, "tc_run", { endedDaysAgo: null, paidCents: null, status: "trialing" }),
    trial(a, "tc_done", { endedDaysAgo: 2, paidCents: 5000, monthlyUsd: 50 }),
  ]);
  const body = await doc();
  assert.equal(body.trialConversion.inFlight, 1);
  const row = body.trialConversion.windows.find((w) => w.days === 30 && w.currency === "USD")!;
  assert.equal(row.cohort, 1);
  assert.equal(row.converted, 1);
  assert.equal(row.convertedMrr, 50);
});

test("trials that ended outside the window are not in it", async () => {
  const a = fixture("window");
  writeStripeSubscriptions([
    trial(a, "tc_old", { endedDaysAgo: 45, paidCents: 0, status: "canceled" }),
    trial(a, "tc_new", { endedDaysAgo: 1, paidCents: 1000 }),
  ]);
  const body = await doc();
  const row30 = body.trialConversion.windows.find((w) => w.days === 30 && w.currency === "USD")!;
  assert.equal(row30.cohort, 1, "the 45-day-old trial belongs to no 30d window");
  const row7 = body.trialConversion.windows.find((w) => w.days === 7 && w.currency === "USD")!;
  assert.equal(row7.cohort, 1, "the 1-day-old trial is in the 7d window too");
});

test("currencies stay apart; a null paid_cents is not a non-conversion", async () => {
  const a = fixture("fx");
  writeStripeSubscriptions([
    trial(a, "tc_usd", { endedDaysAgo: 4, paidCents: null, currency: "usd" }),
    trial(a, "tc_eur", { endedDaysAgo: 6, paidCents: 3000, currency: "eur", monthlyUsd: 25 }),
  ]);
  const body = await doc();
  const rows = body.trialConversion.windows.filter((w) => w.days === 30);
  const by = Object.fromEntries(rows.map((w) => [w.currency, w]));
  /* null = "Stripe never said never" — same rule as churn: counts as paid. */
  assert.equal(by.USD!.converted, 1);
  assert.equal(by.EUR!.cohort, 1);
  assert.equal(by.EUR!.ratePct, 100);
});

test("live rows past their trial are judged by status, not by null paid_cents", async () => {
  const a = fixture("live");
  /* paid_cents is only ever resolved for ENDED rows, so every live row here
     is null — as it is in production. */
  writeStripeSubscriptions([
    trial(a, "tc_active", { endedDaysAgo: 3, paidCents: null, status: "active" }),
    trial(a, "tc_paused", { endedDaysAgo: 3, paidCents: null, status: "paused" }),
    trial(a, "tc_pastdue", { endedDaysAgo: 3, paidCents: null, status: "past_due" }),
    trial(a, "tc_paid_gone", { endedDaysAgo: 3, paidCents: 2000, status: "canceled" }),
  ]);
  const body = await doc();
  const row = body.trialConversion.windows.find((w) => w.days === 30 && w.currency === "USD")!;
  assert.equal(row.cohort, 4);
  assert.equal(row.converted, 2, "active and paid-then-cancelled");
  assert.equal(row.neverPaid, 1, "paused for want of a card");
  assert.equal(row.failing, 1, "past_due first charge");
  assert.equal(row.ratePct, 50);
  assert.equal(row.convertedMrr, 20, "only the converted row still billing adds MRR");
});

test("an empty book publishes an empty cohort list, not an error", async () => {
  fixture("none");
  const body = await doc();
  assert.deepEqual(body.trialConversion.windows, []);
  assert.equal(body.trialConversion.inFlight, 0);
  assert.match(body.trialConversion.basis, /ENDED inside the window/);
});
