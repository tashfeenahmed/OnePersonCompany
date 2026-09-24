/**
 * The Stripe push as a person reads it: one sale is one message, the product
 * and the venture by name, a price a human writes, and every row of a grouped
 * sale accounted for.
 */
import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";
import { db } from "../../db.ts";
import { deliverPending } from "./collect.ts";
import { digestText, groupSales, noticeText, type Lookup, type SubscriptionFacts } from "./notice.ts";
import { insertEvents, type BusinessEventRecord, type EventWrite, type Settings } from "./store.ts";

const Z = "Europe/Dublin";

/** A row as the table holds it; `summary` in the pre-255 shape unless a detail is given. */
function row(p: Partial<BusinessEventRecord> & Pick<BusinessEventRecord, "id" | "type" | "at">): BusinessEventRecord {
  return {
    account_id: 12, account_label: "Account 1", venture_id: null, summary: "", object_id: null, object_type: null,
    customer: "cus_1", amount: null, currency: "usd", delivered_at: null, delivery_error: null, attempts: 0, muted: 0,
    suppressed_by: null, deferred_until: null, seen_at: p.at, subscription: null, detail: null, ...p,
  };
}

const SUBS: Record<string, Partial<SubscriptionFacts>> = {
  sub_known: { product: "FreeLLMAPI Premium", plan: "annual-19-tax-inclusive", bill_interval: "year", interval_count: 1, status: "active", listed_monthly_usd: 1.5833 },
  sub_trial: { product: "CircleChat Cloud Starter", plan: "CircleChat Cloud Starter", bill_interval: "month", interval_count: 1, status: "canceled", listed_monthly_usd: 29, trial_end: "2026-09-22T23:50:04.000Z", paid_cents: 0 },
  sub_lt: { product: "LiveTutor: 3 lessons a week", bill_interval: "month", interval_count: 1, status: "canceled", listed_monthly_usd: 180, paid_cents: 18000 },
};
const lu: Lookup = {
  subscription: (id) => (SUBS[id] ? ({ currency: "usd", plan: null, trial_end: null, paid_cents: null, cancel_at: null, ...SUBS[id] } as SubscriptionFacts) : null),
  productOfPrice: (id) => (id === "price_pro" ? "Sosho Pro" : null),
  plan: (plan) => (plan === "annual-19-tax-inclusive" ? { product: "FreeLLMAPI Premium", bill_interval: "year", interval_count: 1 } : null),
  ventureOfProduct: (p) => (p.startsWith("FreeLLMAPI") ? "FreeLLMAPI" : p.startsWith("CircleChat") ? "CircleChat" : p.startsWith("LiveTutor") ? "LiveTutor" : p.startsWith("Sosho") ? "Sosho" : null),
  ventureName: (id) => ({ "v-3s7ufr": "CircleChat", "v-ccpnln": "FreeLLMAPI" })[id] ?? null,
  failedCharge: () => ({ code: "card_declined", message: "Your card has insufficient funds." }),
};

/* The three rows Stripe wrote for one real sale on 24 Sep, as they were stored
   before migration 255 — no detail, the subscription not yet collected. */
const T = "2026-09-24T21:38:58.000Z";
const NOW = new Date("2026-09-24T21:45:00Z");
const sale = [
  row({ id: "e1", type: "customer.subscription.created", at: T, object_id: "sub_new", summary: "New subscription on annual-19-tax-inclusive (active)." }),
  row({ id: "e2", type: "invoice.paid", at: T, amount: 19, summary: "Invoice paid — USD 19.00." }),
  row({ id: "e3", type: "checkout.session.completed", at: "2026-09-24T21:38:59.000Z", amount: 19, summary: "Checkout completed (subscription) — USD 19.00." }),
];

test("checkout, first invoice and new subscription for one customer are one sale", () => {
  const other = row({ id: "e4", type: "invoice.paid", at: T, customer: "cus_2", amount: 49 });
  const later = row({ id: "e5", type: "invoice.paid", at: "2026-09-24T22:30:00.000Z", amount: 19 });
  const fail = row({ id: "e6", type: "invoice.payment_failed", at: T });
  const groups = groupSales([...sale, other, fail, later]);
  assert.deepEqual(groups.map((g) => g.map((r) => r.id)), [["e1", "e2", "e3"], ["e4"], ["e6"], ["e5"]]);
  assert.equal(noticeText(groups[0]!, lu, Z, 1, NOW), "💰 New sale: FreeLLMAPI Premium, $19/yr");
});

test("the product comes from the subscription row, a price id, or a plan another subscription carries", () => {
  const withDetail = row({
    id: "d1", type: "customer.subscription.created", at: T, object_id: "sub_x", summary: "ignored",
    detail: JSON.stringify({ priceId: "price_pro", interval: "month", unitAmount: 49, status: "active" }), currency: "eur",
  });
  assert.equal(noticeText([withDetail], lu, Z, 1, NOW), "💰 New sale: Sosho Pro, €49/mo");
  const nothing = row({ id: "d2", type: "checkout.session.completed", at: T, amount: 12, summary: "Checkout completed (payment) — USD 12.00." });
  assert.equal(noticeText([nothing], lu, Z, 1, NOW), "💰 New sale: a one-off payment, $12", "no raw id when nothing names it");
  const renewal = row({ id: "d3", type: "invoice.paid", at: T, amount: 19, subscription: "sub_known", detail: JSON.stringify({ billingReason: "subscription_cycle" }) });
  assert.equal(noticeText([renewal], lu, Z, 1, NOW), "🔁 Renewed: FreeLLMAPI Premium, $19/yr");
});

test("a failed payment names the product, the bank's reason and the trial it followed", () => {
  const fail = row({
    id: "f1", type: "invoice.payment_failed", at: "2026-09-23T00:52:21.000Z", venture_id: "v-3s7ufr", amount: 29,
    subscription: "sub_trial", summary: "Invoice payment failed for USD 29.00 on attempt 1.",
  });
  assert.equal(
    noticeText([fail], lu, Z, 1, new Date("2026-09-23T00:55:00Z")),
    "❌ Payment failed: $29 for CircleChat Cloud Starter (not enough funds on the card)\nIt was the first charge after the free trial.",
  );
  assert.match(noticeText([fail], lu, Z, 3, new Date("2026-09-23T00:55:00Z")), /It failed 3 times in the last hour\./);
});

test("cancellations, scheduled cancellations and disputes", () => {
  const ended = row({ id: "c1", type: "customer.subscription.deleted", at: T, object_id: "sub_lt", summary: "Subscription ended, reason recorded by Stripe as “cancellation_requested”." });
  assert.equal(noticeText([ended], lu, Z, 1, NOW), "📉 Cancelled: LiveTutor: 3 lessons a week ($180/mo)\nThey cancelled it themselves.");
  const trial = row({ id: "c2", type: "customer.subscription.deleted", at: T, object_id: "sub_trial", summary: "Subscription ended, reason recorded by Stripe as “cancellation_requested”." });
  assert.equal(noticeText([trial], lu, Z, 1, NOW), "📉 Trial ended without paying: CircleChat Cloud Starter ($29/mo)");
  const leaving = row({
    id: "c3", type: "customer.subscription.updated", at: T, object_id: "sub_known",
    detail: JSON.stringify({ mode: "cancel-scheduled", cancelAt: "2027-08-27T12:12:39.000Z" }),
  });
  assert.equal(noticeText([leaving], lu, Z, 1, NOW), "👋 Cancelling: FreeLLMAPI Premium ($19/yr)\nThey turned off renewal, so it ends on Fri 27 Aug 2027.");
  const dispute = row({
    id: "c4", type: "charge.dispute.created", at: T, amount: 19.53, customer: null,
    summary: "Dispute opened for USD 19.53, reason “product_not_received”. Evidence due 2026-10-04 23:59 UTC.",
  });
  assert.equal(noticeText([dispute], lu, Z, 1, NOW), "🚨 Dispute: $19.53 (they say they never got it)\nEvidence is due by Mon 5 Oct, 12:59am.");
});

test("a notice told late says when it happened, in the owner's zone", () => {
  assert.equal(noticeText(sale, lu, Z, 1, new Date("2026-09-25T07:00:00Z")), "💰 New sale: FreeLLMAPI Premium, $19/yr\nThat was yesterday at 10:38pm.");
});

test("several notices at once are one digest with a headline", () => {
  const text = digestText(
    [
      { rows: sale, standsFor: 1 },
      { rows: [row({ id: "x1", type: "customer.subscription.deleted", at: T, object_id: "sub_lt" })], standsFor: 1 },
      { rows: [row({ id: "x2", type: "invoice.paid", at: T, amount: 19, customer: "cus_9", subscription: "sub_known", detail: '{"billingReason":"subscription_create"}' })], standsFor: 1 },
      { rows: [row({ id: "x3", type: "invoice.payment_failed", at: T, amount: 29, subscription: "sub_trial" })], standsFor: 1 },
    ],
    lu, Z, NOW,
  );
  assert.equal(
    text,
    "⚠️ 2 new sales, 1 failed payment and 1 cancellation\n" +
      "• 💰 New sale: FreeLLMAPI Premium, $19/yr\n" +
      "• 📉 Cancelled: LiveTutor: 3 lessons a week ($180/mo)\n" +
      "• 💰 New sale: FreeLLMAPI Premium, $19/yr\n" +
      "• ❌ Payment failed: $29 for CircleChat Cloud Starter (not enough funds on the card)",
  );
});

/* ------------------------------------------------------ the delivery pass */

const S: Settings = { contactAccess: false, quiet: null, timezone: Z, timezoneFrom: "customers", trialDays: 7, horizonDays: 90, telegram: true };
const write = (p: Partial<EventWrite> & Pick<EventWrite, "id" | "type">): EventWrite => ({
  accountId: 12, accountLabel: "Account 1", ventureId: null, at: new Date(Date.now() - 60_000).toISOString(), summary: "x",
  objectId: null, objectType: null, customer: "cus_live", amount: null, currency: "usd", muted: false, suppressedBy: null, ...p,
});
const ev = (id: string) =>
  db.prepare("SELECT delivered_at, suppressed_by, delivery_error, attempts FROM business_events WHERE id = ?").get(id) as {
    delivered_at: string | null; suppressed_by: string | null; delivery_error: string | null; attempts: number;
  };

beforeEach(() => db.prepare("DELETE FROM business_events").run());

test("one sale is one send, and every row of it is marked delivered", async () => {
  insertEvents([
    write({ id: "s1", type: "customer.subscription.created", objectId: "sub_live", subscription: "sub_live", summary: "New subscription on Premium Annual (active)." }),
    write({ id: "s3", type: "checkout.session.completed", amount: 19, subscription: "sub_live", detail: { mode: "subscription", interval: "year" } }),
  ]);
  const sent: string[] = [];
  const r = await deliverPending(S, async (t) => (sent.push(t), { sent: true }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0], "💰 New sale: Premium Annual, $19/yr");
  assert.equal(r.delivered, 2);
  for (const id of ["s1", "s3"]) assert.ok(ev(id).delivered_at, `${id} delivered`);

  /* The first invoice, split off by a walk boundary, belongs to the sale
     already told. */
  insertEvents([write({ id: "s2", type: "invoice.paid", amount: 19, subscription: "sub_live" })]);
  await deliverPending(S, async (t) => (sent.push(t), { sent: true }));
  assert.equal(sent.length, 1, "nothing sends twice");
  assert.match(ev("s2").suppressed_by ?? "", /^told with the sale in s[13]$/);

  /* A second checkout by the same customer is a second purchase, and news. */
  insertEvents([write({ id: "s5", type: "checkout.session.completed", amount: 49, detail: { mode: "payment" } })]);
  await deliverPending(S, async (t) => (sent.push(t), { sent: true }));
  assert.equal(sent.length, 2);
  assert.equal(sent[1], "💰 New sale: a one-off payment, $49");
});

test("a refused or throwing send fails the whole notice, and the next pass retries it whole", async () => {
  insertEvents([
    write({ id: "r1", type: "customer.subscription.created", objectId: "sub_r", subscription: "sub_r" }),
    write({ id: "r2", type: "invoice.paid", amount: 19, subscription: "sub_r" }),
  ]);
  await deliverPending(S, async () => {
    throw new Error("network down");
  });
  assert.deepEqual([ev("r1").delivery_error, ev("r2").delivery_error], ["network down", "network down"]);
  const sent: string[] = [];
  await deliverPending(S, async (t) => (sent.push(t), { sent: true }));
  assert.equal(sent.length, 1);
  assert.ok(ev("r1").delivered_at && ev("r2").delivered_at);
});

test("more than three notices in one pass are one digest", async () => {
  insertEvents(["a", "b", "c", "d", "e"].map((c) => write({ id: `g${c}`, type: "invoice.paid", customer: `cus_${c}`, amount: 19 })));
  const sent: string[] = [];
  const r = await deliverPending(S, async (t) => (sent.push(t), { sent: true }));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^💰 5 payments\n• 💵 Payment received: \$19\n/);
  assert.equal(r.delivered, 5);
});
