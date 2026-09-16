/**
 * THE PER-VENTURE REVENUE RULE, end to end — seeded, addressed, judged.
 *
 * The bug this file is about was a sentence with nothing behind it. The
 * evidence packet told the model "no alert rule on this box names this
 * venture", and no rule could: every seeded rule was portfolio-wide, and the
 * Stripe document published `mrr` for the account and `products[].mrr` per
 * product with no key a venture could be found under. The sentence was
 * unsatisfiable for revenue, which is the one thing an owner would want
 * watched per business.
 *
 * So there are three things worth proving, and the third is the one a unit
 * test usually skips: that the path the seeder writes resolves against the
 * document the route actually serves. A rule whose path is a typo is not an
 * error anywhere — it is an "unreadable" event every half hour, which reads
 * like an outage.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { db, insertAccount, now, upsertPlugin, writeStripeSubscriptions } from "../../db.ts";
import { seedVentureRules, ventureSeedKey, VENTURE_MRR_MOVE } from "./seed.ts";
import { deleteRule, rules, ruleCountForVenture, seeded } from "./store.ts";
import { judge } from "./engine.ts";
import { checkPath, fromDoc, resolvePath } from "../../shared/metrics-address.ts";
import { stripeRoutes } from "../../routes/stripe.ts";

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** Two ventures with a Stripe product each, one venture with none. */
function fixture() {
  db.exec(
    "DELETE FROM alert_rules; DELETE FROM alert_seeds; DELETE FROM stripe_subscriptions;" +
      " DELETE FROM venture_links; DELETE FROM ventures;",
  );
  const venture = (id: string, slug: string, name: string) =>
    db
      .prepare(
        `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
         VALUES (?,?,?,'','',NULL,'launched','#000','auto',0,'{}',?,?)`,
      )
      .run(id, slug, name, now(), now());
  venture("v-one", "one", "One Co");
  venture("v-two", "two", "Two Co");
  venture("v-unlinked", "unlinked", "Unlinked Co");

  const link = db.prepare(
    "INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at) VALUES (?,?,?,?,?,?)",
  );
  link.run("v-one", "stripe", "Pro", null, "owner", now());
  link.run("v-two", "stripe", "Team", null, "owner", now());

  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", `stripe-${Date.now()}`);
  writeStripeSubscriptions([
    {
      accountId: account, accountLabel: "acc", id: "sub_live", status: "active", currency: "usd",
      monthlyUsd: 30, listedMonthlyUsd: 30, interval: "month", intervalCount: 1, product: "Pro",
      plan: "Pro", createdAt: day(120), endedAt: null, cancelAtPeriodEnd: false, cancelAt: null,
      trialStart: null, trialEnd: null, reason: null, paidCents: 3000,
    },
    {
      /* Ended inside the window: in the figure from thirty days ago and out of
         today's, so this venture's MRR has moved by $75. */
      accountId: account, accountLabel: "acc", id: "sub_gone", status: "canceled", currency: "usd",
      monthlyUsd: 75, listedMonthlyUsd: 75, interval: "month", intervalCount: 1, product: "Pro",
      plan: "Pro", createdAt: day(300), endedAt: day(3), cancelAtPeriodEnd: false, cancelAt: null,
      trialStart: null, trialEnd: null, reason: null, paidCents: 7500,
    },
  ]);
}

test("one rule per venture with a linked Stripe product, and none for the rest", () => {
  fixture();
  const first = seedVentureRules();
  assert.equal(first.created, 2);
  assert.deepEqual(first.names.sort(), ["MRR moved for One Co", "MRR moved for Two Co"]);

  /* `venture_id` is set, which is the whole point: it is what the evidence
     packet counts when it decides whether anything is watching this business. */
  assert.equal(ruleCountForVenture("v-one"), 1);
  assert.equal(ruleCountForVenture("v-two"), 1);
  assert.equal(ruleCountForVenture("v-unlinked"), 0);

  const rule = rules().find((r) => r.venture_id === "v-one")!;
  assert.equal(rule.skill, "stripe");
  assert.equal(rule.path, "byVenture.v-one.mrrAbsDelta");
  assert.equal(rule.op, ">");
  assert.equal(rule.threshold, VENTURE_MRR_MOVE);
  assert.equal(rule.seeded, 1);
});

test("seeding twice leaves one rule per venture", () => {
  fixture();
  seedVentureRules();
  const again = seedVentureRules();
  assert.equal(again.created, 0);
  assert.equal(rules().length, 2);
  assert.equal(ruleCountForVenture("v-one"), 1);
});

test("a deleted suggestion stays deleted — the guard is the seed row, not the table", () => {
  fixture();
  seedVentureRules();
  const rule = rules().find((r) => r.venture_id === "v-one")!;
  /* The owner says no. */
  assert.equal(deleteRule(rule.id), true);
  assert.equal(seeded(ventureSeedKey("v-one")), true);

  seedVentureRules();
  assert.equal(ruleCountForVenture("v-one"), 0);
  assert.equal(ruleCountForVenture("v-two"), 1);
});

test("a venture linked later is seeded on the next pass", () => {
  fixture();
  seedVentureRules();
  db.prepare(
    "INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at) VALUES (?,?,?,?,?,?)",
  ).run("v-unlinked", "stripe", "Solo", null, "owner", now());

  const later = seedVentureRules();
  assert.deepEqual(later.names, ["MRR moved for Unlinked Co"]);
  assert.equal(ruleCountForVenture("v-unlinked"), 1);
});

/* ------------------------------------------------- the address it resolves */

test("the seeded path resolves against the document the Stripe route serves", async () => {
  fixture();
  seedVentureRules();
  const rule = rules().find((r) => r.venture_id === "v-one")!;

  /* The editor would accept the path the seeder wrote. */
  assert.equal(checkPath(rule.path), null);

  const res = await stripeRoutes.request("/?days=30");
  assert.equal(res.status, 200);
  const doc = await res.json();

  /* Keyed by venture id, so it survives a venture being added above it — an
     index would quietly become a different business. */
  const found = resolvePath(doc, rule.path);
  assert.ok(found.ok, found.ok ? "" : found.why);
  assert.equal(found.value, 75);
  const mrr = resolvePath(doc, "byVenture.v-one.mrr");
  assert.ok(mrr.ok);
  assert.equal(mrr.value, 30);
  /* A venture with no linked product is not in the document at all, and the
     failure says so in words rather than reading as a zero. */
  const missing = resolvePath(doc, "byVenture.v-unlinked.mrr");
  assert.equal(missing.ok, false);

  /* The reading and the comparison the engine would actually make. */
  const reading = fromDoc(rule, doc);
  assert.equal(reading.error, null);
  const verdict = judge(rule, reading.value!, { previous: null, windowStart: null });
  assert.equal(verdict.tripped, true);
  assert.match(verdict.message, /byVenture\.v-one\.mrrAbsDelta is 75/);
});

test("a venture whose revenue has not moved does not trip", async () => {
  fixture();
  db.exec("DELETE FROM stripe_subscriptions WHERE id = 'sub_gone'");
  seedVentureRules();
  const rule = rules().find((r) => r.venture_id === "v-one")!;
  const doc = await (await stripeRoutes.request("/?days=30")).json();
  const reading = fromDoc(rule, doc);
  assert.equal(reading.value, 0);
  assert.equal(judge(rule, reading.value!, { previous: null, windowStart: null }).tripped, false);
});
