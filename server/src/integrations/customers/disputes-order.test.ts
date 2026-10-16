import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, upsertPlugin, writeStripeChargeDays } from "../../db.ts";
import { writeDisputes } from "./store.ts";
import { disputeRoutes } from "./disputes-routes.ts";

/*
  The disputes document lists currencies with the account's own one FIRST,
  for the same reason #70 gave for the Stripe report: the cards that read it
  (`payments.alerts`, `payments.disputes`) take row 0 as "the" dispute figure,
  and an alphabetical list put a single euro chargeback in front of two years
  of dollars the day one euro dispute landed.
*/

const DAY = 86_400_000;
const utc = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const day = (n: number) => utc(n).slice(0, 10);

test("a lone euro dispute does not displace the account's main currency", async () => {
  db.exec("DELETE FROM stripe_disputes; DELETE FROM stripe_charge_days;");
  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", "stripe-dispute-order");
  const charge = (n: number, currency: string, gross: number) => ({
    accountId: account, accountLabel: "acc", day: day(n), currency, gross,
    refunded: 0, refunds: 0, succeeded: 1, failed: 0, blocked: 0, declined: 0,
  });
  writeStripeChargeDays([charge(0, "eur", 49), charge(0, "usd", 512), charge(1, "usd", 480)]);

  const dispute = (id: string, currency: string, amount: number) => ({
    id, account_id: account, account_label: "acc", charge: `ch_${id}`,
    payment_intent: null, amount, currency, reason: "product_not_received",
    status: "lost", evidence_due_by: null, submission_count: 1,
    isChargeRefundable: true, created_at: utc(2), terminal: true, outcome: "lost",
    ventureId: null,
  });
  writeDisputes([dispute("dispute:du_eur", "eur", 49), dispute("dispute:du_usd", "usd", 120)]);

  const doc = (await (await disputeRoutes.request("/?days=90")).json()) as {
    currencies: { currency: string }[];
  };
  assert.deepEqual(doc.currencies.map((r) => r.currency), ["USD", "EUR"]);

  db.exec("DELETE FROM stripe_disputes; DELETE FROM stripe_charge_days;");
});
