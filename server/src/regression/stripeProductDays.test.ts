import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, now, setAccountConnected, upsertPlugin, writeStripeCharges } from "../db.ts";
import { stripeRoutes } from "../routes/stripe.ts";

type Doc = {
  productDays: {
    currency: string;
    from: string | null;
    days: { day: string; parts: { product: string | null; ventureId: string | null; host: string | null; gross: number; count: number }[] }[];
  }[];
  recent: { id: string; product: string | null; ventureId: string | null; venture: string | null; host: string | null }[];
  byVenture: Record<string, { host: string | null }>;
};

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

test("succeeded charges are split per day by product, each product carrying its venture", async () => {
  db.exec("DELETE FROM stripe_charges; DELETE FROM stripe_subscriptions; DELETE FROM venture_links; DELETE FROM ventures;");
  db.prepare("DELETE FROM plugin_accounts WHERE plugin_id = 'stripe'").run();
  const venture = db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES (?,?,?,'','',?,'launched','#000','auto',0,'{}',?,?)`,
  );
  venture.run("v-a", "a", "Alpha", "alpha.test", now(), now());
  venture.run("v-b", "b", "Beta", "beta.test", now(), now());
  const link = db.prepare(
    "INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at) VALUES (?,?,?,?,?,?)",
  );
  link.run("v-a", "stripe", "Alpha Pro", null, "owner", now());
  /* Linked to both ventures: it belongs to neither, as it does in the P&L. */
  link.run("v-a", "stripe", "Shared", null, "owner", now());
  link.run("v-b", "stripe", "Shared", null, "owner", now());

  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", "product-days");
  setAccountConnected(account, true);
  const charge = (id: string, amount: number, product: string | null, age: number, status = "succeeded") => ({
    id, accountId: account, amount, currency: "usd", status, paid: status === "succeeded", refunded: false,
    createdAt: ago(age), description: null, emailMasked: null, failureCode: null, failureMessage: null,
    outcomeType: null, product, priceId: null,
  });
  writeStripeCharges([
    charge("ch_1", 19, "alpha pro", 2),
    charge("ch_2", 19, "Alpha Pro", 2),
    charge("ch_3", 5, "Shared", 2),
    charge("ch_4", 7, null, 2),
    charge("ch_5", 99, "Alpha Pro", 2, "failed"),
    charge("ch_6", 30, "Alpha Pro", 40),
  ]);

  const res = await stripeRoutes.request("/?days=30");
  assert.equal(res.status, 200);
  const doc = (await res.json()) as Doc;
  const usd = doc.productDays.find((c) => c.currency === "USD")!;
  assert.ok(usd, "one block per currency");
  assert.equal(usd.days.length, 1, "the charge 40 days old is outside the 30-day window");
  const parts = usd.days[0]!.parts;
  const alpha = parts.find((p) => p.ventureId === "v-a")!;
  assert.equal(alpha.gross, 38, "matched case-insensitively, failed attempts left out");
  assert.equal(alpha.host, "alpha.test");
  assert.equal(parts.find((p) => p.product === "Shared")!.ventureId, null);
  assert.equal(parts.find((p) => p.product === null)!.gross, 7);

  const failed = doc.recent.find((r) => r.id === "ch_5")!;
  assert.equal(failed.venture, "Alpha");
  assert.equal(doc.recent.find((r) => r.id === "ch_4")!.ventureId, null);
  assert.equal(doc.byVenture["v-a"]!.host, "alpha.test");
});
