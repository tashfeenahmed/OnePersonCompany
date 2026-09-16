import test from "node:test";
import assert from "node:assert/strict";
import {
  db, insertAccount, pruneStripeCharges, setAccountConnected, stripeRecentCharges,
  upsertPlugin, writeStripeCharges,
} from "../db.ts";
import { WALK_DAYS, maskEmail } from "../providers/stripe.ts";
import { stripeRoutes } from "../routes/stripe.ts";

type Recent = {
  recent: { id: string; email: string | null; failure: string | null; refunded: boolean; createdAt: string }[];
  recentTruncated: boolean;
  recentHeld: { days: number; from: string | null; total: number };
};

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const charge = (id: string, accountId: number, days: number, extra: Partial<Parameters<typeof writeStripeCharges>[0][number]> = {}) => ({
  id, accountId, amount: 19, currency: "usd", status: "succeeded", paid: true, refunded: false,
  createdAt: ago(days), description: null, emailMasked: maskEmail("test@example.com"),
  failureCode: null, failureMessage: null, outcomeType: "authorized", ...extra,
});

test("an address is masked to its first letter and its host, and a non-address is null", () => {
  assert.equal(maskEmail("test@example.com"), "t***@example.com");
  // A fixed three stars: the mask must not say how long the address was.
  assert.equal(maskEmail("harper.long@example.net"), "h***@example.net");
  assert.equal(maskEmail("a@b.c"), "a***@b.c");
  assert.equal(maskEmail(""), null);
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail(undefined), null);
  assert.equal(maskEmail("not an address"), null);
  assert.equal(maskEmail("@host.only"), null);
  assert.equal(maskEmail("user@"), null);
});

test("charges are kept newest first, replaced by id, and pruned past the walk's edge", async () => {
  db.prepare("DELETE FROM plugin_accounts WHERE plugin_id = 'stripe'").run();
  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", "test");
  setAccountConnected(account, true);

  writeStripeCharges([
    charge("ch_old", account, WALK_DAYS + 5),
    charge("ch_mid", account, 30, { status: "failed", paid: false, failureCode: "card_declined", failureMessage: "Your card was declined." }),
    charge("ch_new", account, 1),
  ]);
  // The rewalk flips a flag on a row already written; a second write must not
  // add a second row for it.
  writeStripeCharges([charge("ch_new", account, 1, { refunded: true })]);

  let held = stripeRecentCharges(10);
  assert.equal(held.total, 3);
  assert.deepEqual(held.rows.map((r) => r.id), ["ch_new", "ch_mid", "ch_old"]);
  assert.equal(held.rows[0]!.refunded, 1);
  // What went in was already masked; the table holds nothing else.
  assert.equal(held.rows[0]!.email_masked, "t***@example.com");
  assert.ok(!held.rows.some((r) => String(r.email_masked).includes("test@")));

  assert.equal(pruneStripeCharges(ago(WALK_DAYS)), 1);
  held = stripeRecentCharges(10);
  assert.equal(held.total, 2);
  assert.equal(held.oldest?.slice(0, 10), ago(30).slice(0, 10));

  // The route: newest first, the failure sentence over its code, and the cap
  // reported as a truncation rather than hidden.
  const res = await stripeRoutes.request("/?days=30");
  assert.equal(res.status, 200);
  const doc = (await res.json()) as Recent;
  assert.deepEqual(doc.recent.map((c) => c.id), ["ch_new", "ch_mid"]);
  assert.equal(doc.recent[0]!.refunded, true);
  assert.equal(doc.recent[0]!.email, "t***@example.com");
  assert.equal(doc.recent[1]!.failure, "Your card was declined.");
  assert.equal(doc.recentTruncated, false);
  assert.equal(doc.recentHeld.days, WALK_DAYS);
  assert.equal(doc.recentHeld.total, 2);
  assert.equal(doc.recentHeld.from, ago(30).slice(0, 10));

  const limited = stripeRecentCharges(1);
  assert.equal(limited.rows.length, 1);
  assert.equal(limited.total, 2);
});

test("what a charge bought, and what came back, survive the write and the rewalk", () => {
  db.prepare("DELETE FROM plugin_accounts WHERE plugin_id = 'stripe'").run();
  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", "attribution");

  writeStripeCharges([
    charge("ch_named", account, 1, { product: "Pro", priceId: "price_pro", amountRefunded: 0 }),
    /* Neither walk could name it. NULL means "not attributable" and must never
       become "Other": an unattributed charge counted into somebody's product
       is one venture's cash on another venture's page. */
    charge("ch_unnamed", account, 1),
  ]);
  let held = stripeRecentCharges(10);
  const named = held.rows.find((r) => r.id === "ch_named")!;
  assert.equal(named.product, "Pro");
  assert.equal(named.price_id, "price_pro");
  assert.equal(named.amount_refunded, 0);
  assert.equal(held.rows.find((r) => r.id === "ch_unnamed")!.product, null);

  /* The rolling rewalk is authoritative: a refund that lands today changes a
     row written weeks ago, and the FIGURE changes with the flag. */
  writeStripeCharges([
    charge("ch_named", account, 1, { product: "Pro", priceId: "price_pro", refunded: true, amountRefunded: 5 }),
  ]);
  held = stripeRecentCharges(10);
  assert.equal(held.total, 2, "a rewalk corrects a row rather than adding one");
  assert.equal(held.rows.find((r) => r.id === "ch_named")!.amount_refunded, 5);
});
