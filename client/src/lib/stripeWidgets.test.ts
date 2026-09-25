import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_BUILDERS, type LiveInputs } from "./liveWidgets.ts";
import { WIDGETS } from "../data/widgets.ts";

const build = (key: string, data: Record<string, unknown>) =>
  LIVE_BUILDERS[key]!({ points: [], ...data } as LiveInputs);

/** A churn row shaped exactly as /api/stripe sends one (the quickRatio field
 *  this card reads is computed server-side over the same new/lost figures the
 *  churn card already prints, so the row below pins both). */
function churnRow(days: number, patch: Record<string, unknown> = {}) {
  return {
    days,
    currency: "usd",
    mrr: 1000,
    newMrr: 160,
    newSubs: 4,
    churnedMrr: 40,
    churnedSubs: 1,
    netMrr: 120,
    ratePct: 4,
    churnedFromStartMrr: 40,
    churnedFromStartSubs: 1,
    startBookMrr: 1000,
    quickRatio: 0.8,
    subRatePct: 5,
    startSubs: 20,
    notChurn: {
      trialNonConversion: { subscriptions: 0, wouldHaveBeen: 0 },
      failedActivation: { subscriptions: 0, wouldHaveBeen: 0 },
    },
    involuntary: 0,
    byProduct: [],
    basis: "",
    approximate: true,
    ...patch,
  };
}
const stripe = (row: Record<string, unknown> | null) => ({ stripe: { churn: row ? [row] : [] } });

test("quick ratio card exists and stays empty without a churn row", () => {
  assert.ok(WIDGETS["stripe.quickRatio"], "catalog entry");
  assert.equal(build("stripe.quickRatio", stripe(null)), null);
  assert.equal(build("stripe.quickRatio", stripe(churnRow(30, { quickRatio: null }))), null, "0/0 is no measurement, not 0.00");
});

test("quick ratio divides the window's movement and says so in dollars", () => {
  const p = build("stripe.quickRatio", { window: 30, ...stripe(churnRow(30)) })!;
  assert.equal(p.value, "0.80");
  assert.equal(p.tone, "ok");
  assert.match(p.sub!, /US\$160 in, US\$40 out/);
  assert.match(p.sub!, /4× more new MRR than lost/);
});

test("quick ratio below the 0.8 benchmark warns with the benchmark in words", () => {
  const p = build("stripe.quickRatio", {
    window: 30,
    ...stripe(churnRow(30, { newMrr: 100, churnedMrr: 100, quickRatio: 0.5 })),
  })!;
  assert.equal(p.value, "0.50");
  assert.equal(p.tone, "warn");
  assert.match(p.sub!, /below 0\.80/);
});

test("a window that lost money and gained none reads as 0.00, not as no measurement", () => {
  const p = build("stripe.quickRatio", {
    window: 30,
    ...stripe(churnRow(30, { newMrr: 0, churnedMrr: 120, quickRatio: 0 })),
  })!;
  assert.equal(p.value, "0.00");
  assert.equal(p.tone, "warn");
});

test("a window that gained and lost nothing churned never divides by zero", () => {
  const p = build("stripe.quickRatio", {
    window: 30,
    ...stripe(churnRow(30, { newMrr: 200, churnedMrr: 0, quickRatio: 1 })),
  })!;
  assert.equal(p.value, "1.00");
  assert.match(p.sub!, /nothing churned in the window/);
});

test("quick ratio follows the currency of the churn row it reads", () => {
  const p = build("stripe.quickRatio", { window: 30, ...stripe(churnRow(30, { currency: "eur" })) })!;
  assert.match(p.sub!, /€160 in, €40 out/);
});

test("the all-time picker names the 90-day window it actually reads", () => {
  const p = build("stripe.quickRatio", { window: "all", ...stripe(churnRow(90)) })!;
  assert.equal(p.name, "Quick ratio · 90d");
});
