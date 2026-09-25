import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_BUILDERS, type LiveInputs } from "./liveWidgets.ts";
import { WIDGETS } from "../data/widgets.ts";

const build = (key: string, data: Record<string, unknown>) =>
  LIVE_BUILDERS[key]!({ points: [], ...data } as LiveInputs);

/** A churn row shaped exactly as /api/stripe sends one. The quick ratio and
 *  its two sides are computed server-side; the card only reads them. */
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
    quickRatio: 4,
    quickRatioInMrr: 160,
    quickRatioOutMrr: 40,
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

test("quick ratio card exists and stays empty without a churn row or any movement", () => {
  assert.ok(WIDGETS["stripe.quickRatio"], "catalog entry");
  assert.equal(build("stripe.quickRatio", stripe(null)), null);
  assert.equal(
    build("stripe.quickRatio", stripe(churnRow(30, { quickRatio: null, quickRatioInMrr: 0, quickRatioOutMrr: 0 }))),
    null,
    "a window that moved nothing is no measurement",
  );
});

test("quick ratio is gained over lost, with both sides in money", () => {
  const p = build("stripe.quickRatio", { window: 30, ...stripe(churnRow(30)) })!;
  assert.equal(p.value, "4.00×");
  assert.equal(p.tone, "ok");
  assert.match(p.sub!, /US\$160 new MRR in, US\$40 churned out/);
  assert.match(p.sub!, /at or above the 4× healthy line/);
  assert.match(p.sub!, /upgrades and downgrades not counted/);
});

test("between 1 and 4 the book grows but warns", () => {
  const p = build("stripe.quickRatio", {
    window: 30,
    ...stripe(churnRow(30, { quickRatio: 2, quickRatioInMrr: 100, quickRatioOutMrr: 50 })),
  })!;
  assert.equal(p.value, "2.00×");
  assert.equal(p.tone, "warn");
  assert.match(p.sub!, /under the 4× healthy line/);
});

test("just under 4 is not rounded up into the healthy tone", () => {
  const p = build("stripe.quickRatio", {
    window: 30,
    ...stripe(churnRow(30, { quickRatio: 3.96, quickRatioInMrr: 99, quickRatioOutMrr: 25 })),
  })!;
  assert.equal(p.value, "3.96×");
  assert.equal(p.tone, "warn");
});

test("under 1 the book is shrinking and reads bad", () => {
  const p = build("stripe.quickRatio", {
    window: 30,
    ...stripe(churnRow(30, { quickRatio: 0, quickRatioInMrr: 0, quickRatioOutMrr: 120 })),
  })!;
  assert.equal(p.value, "0.00×");
  assert.equal(p.tone, "bad");
  assert.match(p.sub!, /shrinking/);
});

test("growth with nothing churned never divides by zero", () => {
  const p = build("stripe.quickRatio", {
    window: 30,
    ...stripe(churnRow(30, { quickRatio: null, quickRatioInMrr: 200, quickRatioOutMrr: 0 })),
  })!;
  assert.equal(p.value, "No churn");
  assert.equal(p.tone, "ok");
  assert.match(p.sub!, /nothing churned in the window/);
});

test("quick ratio follows the currency of the churn row it reads", () => {
  const p = build("stripe.quickRatio", { window: 30, ...stripe(churnRow(30, { currency: "eur" })) })!;
  assert.match(p.sub!, /€160 new MRR in, €40 churned out/);
});

test("the all-time picker names the 90-day window it actually reads", () => {
  const p = build("stripe.quickRatio", { window: "all", ...stripe(churnRow(90)) })!;
  assert.equal(p.name, "Quick ratio · 90d");
});

/* ---- stripe.atRisk: the money on past-due subscriptions ---- */

const atRisk = (row: Record<string, unknown> | null) => ({ stripe: row ? { atRisk: row } : null });

test("at-risk card exists and needs the document", () => {
  assert.ok(WIDGETS["stripe.atRisk"], "catalog entry");
  assert.equal(build("stripe.atRisk", atRisk(null)), null);
});

test("at-risk MRR names the money and how many cards failed", () => {
  const p = build("stripe.atRisk", atRisk({
    subscriptions: 3,
    mrr: [{ currency: "USD", amount: 137.5 }],
    note: "",
  }))!;
  assert.equal(p.value, "US$138");
  assert.equal(p.tone, "bad");
  assert.match(p.sub!, /3 subscriptions failed to collect/);
  assert.match(p.sub!, /not in MRR until it collects/);
});

test("one failed subscription reads as one subscription", () => {
  const p = build("stripe.atRisk", atRisk({
    subscriptions: 1,
    mrr: [{ currency: "EUR", amount: 20 }],
    note: "",
  }))!;
  assert.match(p.sub!, /1 subscription failed to collect/);
});

test("nothing past due is the good news: zero, tone ok", () => {
  const p = build("stripe.atRisk", atRisk({ subscriptions: 0, mrr: [], note: "" }))!;
  assert.equal(p.value, "—");
  assert.equal(p.tone, "ok");
  assert.match(p.sub!, /nothing past due right now/);
});

test("several currencies are counted apart, not blended", () => {
  const p = build("stripe.atRisk", atRisk({
    subscriptions: 3,
    mrr: [{ currency: "USD", amount: 30 }, { currency: "EUR", amount: 40 }],
    note: "",
  }))!;
  assert.match(p.sub!, /2 currencies counted apart/);
});
