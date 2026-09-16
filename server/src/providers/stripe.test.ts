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

import { sessionAttribution } from "./stripe.ts";

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
