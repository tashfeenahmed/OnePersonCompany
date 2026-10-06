import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, upsertPlugin, writeStripeChargeDays } from "../db.ts";
import { stripeRoutes } from "./stripe.ts";

/*
  The account's own currency comes FIRST in every per-currency list. Cards
  read row 0 as "the" figure; sorted by name, the first euro charge on a
  five-year USD account put a one-day €39 series in front of everything and
  the Overview's daily chart drew a single point.
*/

const DAY = 86_400_000;
const utc = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

test("a small new currency does not displace the account's main one", async () => {
  db.exec("DELETE FROM stripe_charge_days");
  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", "stripe-order");
  const row = (n: number, currency: string, gross: number) => ({
    accountId: account, accountLabel: "acc", day: utc(n), currency, gross,
    refunded: 0, refunds: 0, succeeded: 1, failed: 0, blocked: 0, declined: 0,
  });
  writeStripeChargeDays([row(0, "eur", 39), row(0, "usd", 416), row(1, "usd", 386), row(2, "usd", 310)]);

  const doc = (await (await stripeRoutes.request("/?days=30")).json()) as {
    charges: { currency: string; series: unknown[] }[];
  };
  assert.deepEqual(doc.charges.map((c) => c.currency), ["USD", "EUR"]);
  assert.equal(doc.charges[0]!.series.length, 3);
  db.exec("DELETE FROM stripe_charge_days");
});
