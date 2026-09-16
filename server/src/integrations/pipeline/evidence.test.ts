/**
 * THE EVIDENCE PACKET'S TWO HONESTY PROBLEMS, held to account.
 *
 * ONE-OFF CASH USED TO BE INVISIBLE HERE. The packet read `stripe_subscriptions`
 * and nothing else, so a business whose money arrives as lifetime purchases —
 * on this box, hundreds of succeeded charges a month against no subscription at
 * all — was handed to the model as a venture earning nothing. Every proposal
 * written from that packet was about a business that does not exist.
 *
 * AND THE ALERT SENTENCE WAS UNSATISFIABLE. "No alert rule on this box names
 * this venture" was printed whenever the count was zero, with no way for a
 * reader to learn what WAS being watched when it was not — so "nothing is
 * open" read the same under two rules watching the money as under none.
 *
 * Both are read out of the real tables here rather than from a hand-built
 * object, because the bug in each case was in the reading.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  insertAccount,
  now,
  upsertPlugin,
  writeStripeCharges,
  writeStripeSubscriptions,
  type VentureRow,
} from "../../db.ts";
import { packetFor } from "./evidence.ts";
import { renderPacket } from "./synthesis.ts";
import { insertRule } from "../proactive/store.ts";

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function fixture(opts: { subscription?: boolean } = {}): string {
  db.exec(
    "DELETE FROM stripe_charges; DELETE FROM stripe_subscriptions; DELETE FROM venture_links;" +
      " DELETE FROM alert_rules; DELETE FROM ventures;",
  );
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES (?,?,?,?,'',NULL,'launched','#000','auto',0,'{}',?,?)`,
  ).run("v-api", "api", "Free API", "Sells a lifetime licence.", now(), now());
  db.prepare(
    "INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at) VALUES (?,?,?,?,?,?)",
  ).run("v-api", "stripe", "Lifetime", null, "owner", now());

  upsertPlugin("stripe", true, null);
  const account = insertAccount("stripe", `stripe-${Date.now()}`);

  /* A subscription has to exist or the packet stops at "the collector holds no
     subscription rows for these products" — which is the honest answer, and is
     its own test below. */
  if (opts.subscription !== false)
    writeStripeSubscriptions([
      {
        accountId: account, accountLabel: "acc", id: "sub_1", status: "active", currency: "usd",
        monthlyUsd: 10, listedMonthlyUsd: 10, interval: "month", intervalCount: 1,
        product: "Lifetime", plan: "support", createdAt: day(120), endedAt: null,
        cancelAtPeriodEnd: false, cancelAt: null, trialStart: null, trialEnd: null,
        reason: null, paidCents: 1000,
      },
    ]);

  writeStripeCharges(
    [2, 5, 9, 12].map((age, i) => ({
      id: `ch_${i}`,
      accountId: account,
      amount: 49,
      currency: "usd",
      status: "succeeded",
      paid: true,
      refunded: false,
      createdAt: day(age),
      description: null,
      emailMasked: null,
      failureCode: null,
      failureMessage: null,
      outcomeType: null,
      product: "Lifetime",
      priceId: "price_life",
    })),
  );
  return "v-api";
}

test("the revenue packet carries one-off cash beside MRR, and never inside it", async () => {
  const id = fixture();
  const packet = (await packetFor(id))!;
  const revenue = packet.revenue.measured!;

  /* MRR is untouched: the subscription and nothing else. */
  assert.deepEqual(revenue.mrr, { USD: 10 });
  /* And the cash that was invisible is measured, dated, and labelled. */
  assert.equal(revenue.oneOff.count, 4);
  assert.deepEqual(revenue.oneOff.gross, { USD: 196 });
  assert.deepEqual(revenue.oneOff.byProduct, [
    { product: "Lifetime", currency: "USD", count: 4, gross: 196 },
  ]);
  assert.match(revenue.oneOff.window, /one-off/i);
  /* The model is told WHY it is not in MRR, so it cannot report it as one. */
  assert.match(revenue.note, /ONE-OFF PURCHASES ARE EXCLUDED FROM MRR BY DESIGN/);
});

test("the readable packet prints the one-off line the model will quote", async () => {
  const id = fixture();
  const text = renderPacket((await packetFor(id))!);
  assert.match(text, /MRR now 10 USD/);
  assert.match(text, /One-off purchases \(settled cash, NOT a run rate and not in MRR\): 4 in 30 days, 196 USD\./);
  assert.match(text, /- Lifetime: 4 purchase\(s\), 196 USD\./);
});

test("a venture whose money is all one-off still reports no MRR rather than a guess", async () => {
  /* No subscription row at all: the packet says so — it does not quietly
     report the lifetime cash as revenue it could not measure. */
  const id = fixture({ subscription: false });
  const packet = (await packetFor(id))!;
  assert.equal(packet.revenue.measured, null);
  assert.match(packet.revenue.why!, /holds no subscription rows/);
});

/* ------------------------------------------------------------------ alerts */

test("with no rule naming the venture, the packet says nothing is watching it", async () => {
  const id = fixture();
  const packet = (await packetFor(id))!;
  assert.equal(packet.alerts.measured, null);
  assert.match(packet.alerts.why!, /no alert rule on this box names this venture/);
});

test("with a rule naming the venture, the packet names the rule rather than counting it", async () => {
  const id = fixture();
  insertRule({
    name: "MRR moved for Free API",
    skill: "stripe",
    view: "default",
    params: {},
    path: `byVenture.${id}.mrrAbsDelta`,
    op: ">",
    threshold: 20,
    windowMinutes: null,
    ventureId: id,
    enabled: true,
    cooldownMinutes: 1440,
    seeded: true,
  });

  const packet = (await packetFor(id))!;
  const alerts = packet.alerts.measured!;
  assert.deepEqual(alerts.watching, [
    { name: "MRR moved for Free API", skill: "stripe", path: `byVenture.${id}.mrrAbsDelta`, enabled: true },
  ]);
  assert.deepEqual(alerts.open, []);

  /* And the readable packet says which rule's silence "nothing is open" is. */
  const text = renderPacket(packet);
  assert.match(text, /1 rule\(s\) watch this venture: “MRR moved for Free API”/);
  assert.match(text, /Nothing is open\./);
});

/* A row shape this file asserts on, so a column rename here is a test failure
   rather than a silently empty packet. */
test("the fixture venture is a real row", () => {
  const v = db.prepare("SELECT * FROM ventures WHERE id = 'v-api'").get() as VentureRow | undefined;
  assert.ok(v);
});
