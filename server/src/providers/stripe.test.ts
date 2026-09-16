/**
 * WHAT A ONE-OFF PAYMENT WAS FOR, decided one session at a time.
 *
 * This is the join the whole per-venture cash figure rests on: a charge has no
 * product, a Checkout Session has the line items, and the payment intent is the
 * one id they share. Every rule in it is a decision about somebody's revenue
 * appearing under the right business or under none, so each is held here —
 * including the two Stripe does not let the query express (`mode` and
 * `payment_status` are not documented list filters, so they are applied to the
 * objects that come back, and a session that slipped through would be counted
 * as one-off cash it is not).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { invoiceAttribution, pickAttribution, sessionAttribution } from "./stripe.ts";

const prices = new Map<string, string>([["price_life", "Lifetime Licence"]]);

const paid = (over: Record<string, unknown> = {}) => ({
  mode: "payment",
  payment_status: "paid",
  payment_intent: "pi_1",
  line_items: { data: [{ price: { id: "price_life", product: "prod_1" } }] },
  ...over,
});

test("a paid one-off session names its product, its price and the intent that paid", () => {
  assert.deepEqual(sessionAttribution(paid(), prices), {
    intent: "pi_1",
    priceId: "price_life",
    product: "Lifetime Licence",
  });
});

test("an expanded product's own name is preferred to the price list", () => {
  const got = sessionAttribution(
    paid({ line_items: { data: [{ price: { id: "price_life", product: { name: "Lifetime (2026)" } } }] } }),
    prices,
  );
  assert.equal(got!.product, "Lifetime (2026)");
});

test("a subscription checkout is not one-off cash", () => {
  assert.equal(sessionAttribution(paid({ mode: "subscription" }), prices), null);
});

test("a completed but unpaid session is not cash at all", () => {
  assert.equal(sessionAttribution(paid({ payment_status: "unpaid" }), prices), null);
});

test("a session with no payment intent cannot be joined to a charge", () => {
  assert.equal(sessionAttribution(paid({ payment_intent: null }), prices), null);
  /* Expanded rather than an id: the same session, the other shape. */
  assert.equal(sessionAttribution(paid({ payment_intent: { id: "pi_9" } }), prices)!.intent, "pi_9");
});

test("an ad-hoc price nobody can name stays null rather than becoming Other", () => {
  const got = sessionAttribution(
    paid({ line_items: { data: [{ price: { id: "price_unknown", product: "prod_x" } }] } }),
    prices,
  );
  /* Null here means "not attributable", and `ventureOneOff` counts it for
     nobody — which is the only honest thing to do with somebody's money. */
  assert.deepEqual(got, { intent: "pi_1", priceId: "price_unknown", product: null });
});

test("a session whose line items did not come back is still joinable, with no product", () => {
  /* The fallback path: Stripe refused the expansion, so the walk repeated
     without it. The payment is known to be one-off; what it bought is not. */
  const got = sessionAttribution(paid({ line_items: null }), prices);
  assert.deepEqual(got, { intent: "pi_1", priceId: null, product: null });
});

/**
 * THE OTHER HALF OF THE SAME JOIN — a paid invoice, which is where a
 * subscription renewal's product still exists. A Checkout Session is created
 * once, when somebody buys; the renewals that follow it have no session at
 * all, so an account whose revenue is subscriptions was entirely unattributed
 * until this walk. These are the rules that decide whose revenue it is.
 */
const invoicePrices = new Map<string, string>([["price_pro", "Pro"]]);

const invoice = (over: Record<string, unknown> = {}) => ({
  status: "paid",
  amount_paid: 2900,
  charge: "ch_1",
  payment_intent: "pi_1",
  lines: { data: [{ price: { id: "price_pro", product: "prod_1" } }] },
  ...over,
});

test("a paid invoice names its product, its charge and the intent that paid it", () => {
  assert.deepEqual(invoiceAttribution(invoice(), invoicePrices), {
    charge: "ch_1",
    intent: "pi_1",
    priceId: "price_pro",
    product: "Pro",
  });
});

test("an invoice's own expanded product name beats the price list", () => {
  const got = invoiceAttribution(
    invoice({ lines: { data: [{ price: { id: "price_pro", product: { name: "Pro (2026)" } } }] } }),
    invoicePrices,
  );
  assert.equal(got!.product, "Pro (2026)");
});

test("a draft, open or void invoice is not money that arrived", () => {
  for (const status of ["draft", "open", "void", "uncollectible"])
    assert.equal(invoiceAttribution(invoice({ status }), invoicePrices), null, status);
});

test("a fully discounted invoice settles no charge and attributes nothing", () => {
  assert.equal(invoiceAttribution(invoice({ amount_paid: 0, charge: null }), invoicePrices), null);
});

test("an invoice that reaches neither a charge nor an intent cannot be joined", () => {
  assert.equal(invoiceAttribution(invoice({ charge: null, payment_intent: null }), invoicePrices), null);
  /* Expanded rather than an id: the same invoice, the other shape. */
  const expanded = invoiceAttribution(
    invoice({ charge: { id: "ch_9" }, payment_intent: { id: "pi_9" } }),
    invoicePrices,
  );
  assert.equal(expanded!.charge, "ch_9");
  assert.equal(expanded!.intent, "pi_9");
});

test("an invoice line nobody can name stays null rather than becoming Other", () => {
  const got = invoiceAttribution(
    invoice({ lines: { data: [{ price: { id: "price_adhoc" } }] } }),
    invoicePrices,
  );
  assert.deepEqual(got, { charge: "ch_1", intent: "pi_1", priceId: "price_adhoc", product: null });
  /* And a line item that did not come back at all. */
  assert.equal(invoiceAttribution(invoice({ lines: null }), invoicePrices)!.product, null);
});

/* ------------------------------------------------- which source names a charge */

const pro = { product: "Pro", priceId: "price_pro" };
const lifetime = { product: "Lifetime", priceId: "price_life" };
const nameless = { product: null, priceId: "price_adhoc" };

test("the charge id wins over the payment intent, because a retry makes two charges of one intent", () => {
  const got = pickAttribution("ch_1", "pi_1", {
    byCharge: new Map([["ch_1", pro]]),
    byIntent: new Map([["pi_1", lifetime]]),
  });
  assert.deepEqual(got, pro);
});

test("a hit with no product does not block one that has a product", () => {
  /* The invoice named the charge and could not name an ad-hoc line; the
     session knows what the customer actually chose. */
  const got = pickAttribution("ch_1", "pi_1", {
    byCharge: new Map([["ch_1", nameless]]),
    byIntent: new Map([["pi_1", lifetime]]),
  });
  assert.deepEqual(got, lifetime);
});

test("where neither source has a product, the charge-keyed hit still carries its price", () => {
  const got = pickAttribution("ch_1", "pi_1", { byCharge: new Map([["ch_1", nameless]]) });
  assert.deepEqual(got, nameless);
});

test("a charge no walk saw is unattributed, which is never Other", () => {
  assert.equal(pickAttribution("ch_x", "pi_x", { byCharge: new Map(), byIntent: new Map() }), null);
  assert.equal(pickAttribution("ch_x", null, {}), null);
  /* The intent alone still answers — an account using Checkout without
     invoicing has no charge-keyed source at all. */
  assert.deepEqual(pickAttribution("ch_x", "pi_1", { byIntent: new Map([["pi_1", pro]]) }), pro);
});
