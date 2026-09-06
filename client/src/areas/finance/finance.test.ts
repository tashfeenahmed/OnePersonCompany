import test from "node:test";
import assert from "node:assert/strict";
import { amount, currencies, parseAmount, shownShare } from "./format.ts";

test("an untouched allocation field saves the share it is showing, not zero", () => {
  const allocations = [
    { ventureId: "v-a", share: 0.4 },
    { ventureId: "v-b", share: 0.4 },
    { ventureId: "v-c", share: 0.2 },
  ];
  // The owner edits one field and presses Save. The other two must go back as
  // what the page was showing, or `PUT /allocations` replaces the set with 50/0/0.
  assert.equal(shownShare("50", allocations, "v-a"), "50");
  assert.equal(shownShare(undefined, allocations, "v-b"), "40");
  assert.equal(shownShare(undefined, allocations, "v-c"), "20");
  // A venture with no share shows nothing, and an emptied field stays empty.
  assert.equal(shownShare(undefined, allocations, "v-d"), "");
  assert.equal(shownShare("", allocations, "v-b"), "");
});

test("a mistyped price is refused, and only an empty field means the price is unknown", () => {
  assert.deepEqual(parseAmount("12o"), {
    error: "“12o” is not an amount. Type a number, or clear the field if you do not know the price.",
  });
  assert.ok("error" in parseAmount("-3"));
  assert.deepEqual(parseAmount(""), { amount: null });
  assert.deepEqual(parseAmount("  "), { amount: null });
  assert.deepEqual(parseAmount(" 31.2 "), { amount: 31.2 });
  assert.deepEqual(parseAmount("0"), { amount: 0 });
});

/* THE OUTPUT CONVENTION CHANGED ON PURPOSE and the assertions moved with it.
   This area wrote "63.47 EUR" while the customers tabs wrote "EUR 63.47" and
   the analytics join wrote "€63.47", so one Stripe amount had three spellings
   across three screens. `amount` is now `money` from `@/lib/format`, whose
   en-GB locale is the deliberate part: it renders US dollars as "US$" rather
   than a bare "$" that also reads as Canadian and Australian on a box holding
   all three. WHAT THIS TEST IS ABOUT IS UNCHANGED — a missing price is a dash
   and never "0.00", and two currencies are listed side by side with a middle
   dot rather than added. */
test("a null price renders as a dash and currencies are never joined by a plus", () => {
  assert.equal(amount(null, "usd"), "—");
  assert.equal(amount(0, "usd"), "US$0.00");
  assert.equal(
    currencies([{ currency: "EUR", amount: 63.47 }, { currency: "USD", amount: 2.6 }]),
    "€63.47  ·  US$2.60",
  );
  assert.equal(currencies([]), "—");
});
