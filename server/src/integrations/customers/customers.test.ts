/**
 * The three decisions this area gets wrong silently if they are wrong, tested
 * against fixtures rather than against Stripe.
 *
 *   DEDUPE AND COLLAPSING — a notifier that sends the same thing twice, or
 *   four times for one dying card, is a notifier the owner mutes.
 *   QUIET HOURS — a deferral computed with arithmetic on an offset is right
 *   until the clocks change.
 *   CASE RESOLUTION — "resolves when Stripe shows it fixed" is a claim, and
 *   the only way to know it is true is to run it.
 *
 * Everything under test is a pure function over rows. There is no database
 * here, no clock and no key: `node --experimental-strip-types --test` runs it
 * in a few milliseconds and it fails for exactly one reason.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  collapseFailures,
  coveredBy,
  parseEvent,
  quietDeferral,
  type AlertTrip,
  type Collapsible,
} from "./events.ts";
import { inQuiet, parseQuiet } from "./store.ts";
import { deriveCases, resolutionFor, ENDED_WINDOW_DAYS } from "./cases.ts";
import { compose, longDate } from "./draft.ts";
import type { CaseRecord } from "./store.ts";
import type { StripeSubscriptionRecord } from "../../db.ts";
import type { VentureMap } from "./venture.ts";

/* ------------------------------------------------------------- fixtures */

const T0 = Date.parse("2026-09-06T12:00:00.000Z");

const sub = (over: Partial<StripeSubscriptionRecord> = {}): StripeSubscriptionRecord => ({
  id: "sub_1",
  account_id: 1,
  account_label: "Account 1",
  status: "active",
  currency: "usd",
  monthly_usd: 29,
  listed_monthly_usd: 29,
  bill_interval: "month",
  interval_count: 1,
  product: "Widgets",
  plan: "Pro monthly",
  created_at: "2025-01-01T00:00:00.000Z",
  ended_at: null,
  cancel_at_period_end: 0,
  cancel_at: null,
  trial_start: null,
  trial_end: null,
  reason: null,
  paid_cents: 29_00,
  seen_at: "2026-09-06T11:00:00.000Z",
  ...over,
});

const emptyVentures = (): VentureMap => ({
  byProduct: new Map(),
  bySubscription: new Map(),
  sole: null,
  ventures: 0,
});

const caseOf = (over: Partial<CaseRecord> = {}): CaseRecord => ({
  id: "churn:sub_1",
  venture_id: null,
  account_id: 1,
  account_label: "Account 1",
  kind: "churn",
  customer: "cus_1",
  email_hash: null,
  email_domain: null,
  email_plain: null,
  subject_ref: "sub_1",
  amount: 29,
  currency: "usd",
  deadline: "2026-10-16T00:00:00.000Z",
  deadline_is: "the end of the paid period",
  context: JSON.stringify({ state: "cancellation scheduled", product: "Widgets", cancelAt: "2026-10-16T00:00:00.000Z" }),
  status: "open",
  resolution: null,
  outbox_id: null,
  opened_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  resolved_at: null,
  ...over,
});

/* --------------------------------------------------------------- dedupe */

test("an event id appearing twice in one walk is one row's worth of writes", () => {
  /* The dedupe itself is the table's primary key, so what is testable here is
     that the parse is deterministic: two reads of the same payload produce
     the same summary and the same object reference, so an overlapping walk
     cannot produce a second, differently-worded row. */
  const payload = { id: "in_1", amount_due: 4200, currency: "usd", attempt_count: 3 };
  const a = parseEvent("invoice.payment_failed", payload, null);
  const b = parseEvent("invoice.payment_failed", { ...payload }, null);
  assert.equal(a.summary, b.summary);
  assert.equal(a.summary, "Invoice payment failed for USD 42.00 on attempt 3.");
  assert.equal(a.isPaymentFailure, true);
});

test("a subscription update that moved nothing a person acts on is uninteresting", () => {
  const quiet = parseEvent("customer.subscription.updated", { id: "sub_1", status: "active" }, { metadata: {} });
  assert.equal(quiet.uninteresting, true);

  const scheduled = parseEvent(
    "customer.subscription.updated",
    { id: "sub_1", status: "active", cancel_at_period_end: true },
    { cancel_at_period_end: false },
  );
  assert.equal(scheduled.uninteresting, false);
  assert.match(scheduled.summary, /Cancellation scheduled/);

  const terminal = parseEvent(
    "customer.subscription.updated",
    { id: "sub_1", status: "past_due" },
    { status: "active" },
  );
  assert.equal(terminal.uninteresting, false);
  assert.match(terminal.summary, /now past_due/);
});

test("a summary never invents a figure the payload did not carry", () => {
  const bare = parseEvent("invoice.payment_failed", { id: "in_2" }, null);
  assert.equal(bare.amount, null);
  assert.equal(bare.summary, "Invoice payment failed.");
  assert.ok(!/\d/.test(bare.summary), "no number appears where none was reported");
});

/* ------------------------------------------------------------ collapsing */

test("four failures for one customer inside an hour become one message", () => {
  const rows: Collapsible[] = [
    { id: "evt_1", type: "invoice.payment_failed", at: "2026-09-06T09:00:00.000Z", customer: "cus_a" },
    { id: "evt_2", type: "invoice.payment_failed", at: "2026-09-06T09:12:00.000Z", customer: "cus_a" },
    { id: "evt_3", type: "invoice.payment_failed", at: "2026-09-06T09:40:00.000Z", customer: "cus_a" },
    { id: "evt_4", type: "invoice.payment_failed", at: "2026-09-06T09:59:00.000Z", customer: "cus_a" },
  ];
  const { collapsed, standsFor } = collapseFailures(rows);
  assert.equal(collapsed.size, 3);
  for (const id of ["evt_2", "evt_3", "evt_4"]) assert.equal(collapsed.get(id), "evt_1");
  assert.equal(standsFor.get("evt_1"), 4);
});

test("the window restarts, so a card still failing tomorrow is still worth a line", () => {
  const rows: Collapsible[] = [
    { id: "evt_1", type: "invoice.payment_failed", at: "2026-09-06T09:00:00.000Z", customer: "cus_a" },
    { id: "evt_2", type: "invoice.payment_failed", at: "2026-09-06T09:30:00.000Z", customer: "cus_a" },
    { id: "evt_3", type: "invoice.payment_failed", at: "2026-09-06T11:00:00.000Z", customer: "cus_a" },
  ];
  const { collapsed, standsFor } = collapseFailures(rows);
  assert.equal(collapsed.get("evt_2"), "evt_1");
  assert.equal(collapsed.has("evt_3"), false, "past the window it opens its own");
  assert.equal(standsFor.get("evt_1"), 2);
});

test("two customers failing in the same minute are two people", () => {
  const rows: Collapsible[] = [
    { id: "evt_1", type: "invoice.payment_failed", at: "2026-09-06T09:00:00.000Z", customer: "cus_a" },
    { id: "evt_2", type: "invoice.payment_failed", at: "2026-09-06T09:00:30.000Z", customer: "cus_b" },
  ];
  assert.equal(collapseFailures(rows).collapsed.size, 0);
});

test("failures with no customer id collapse with nothing, and other types never collapse", () => {
  const rows: Collapsible[] = [
    { id: "evt_1", type: "invoice.payment_failed", at: "2026-09-06T09:00:00.000Z", customer: null },
    { id: "evt_2", type: "invoice.payment_failed", at: "2026-09-06T09:05:00.000Z", customer: null },
    { id: "evt_3", type: "invoice.paid", at: "2026-09-06T09:06:00.000Z", customer: "cus_a" },
    { id: "evt_4", type: "invoice.paid", at: "2026-09-06T09:07:00.000Z", customer: "cus_a" },
  ];
  assert.equal(collapseFailures(rows).collapsed.size, 0);
});

/* ----------------------------------------------------------- quiet hours */

test("quiet hours parse, refusing the typo that would mute everything forever", () => {
  assert.deepEqual(parseQuiet("22-8"), { from: 22, to: 8 });
  assert.deepEqual(parseQuiet(" 22 - 8 "), { from: 22, to: 8 });
  assert.equal(parseQuiet("off"), null);
  assert.equal(parseQuiet(""), null);
  assert.equal(parseQuiet("8-8"), null, "the same hour twice is a typo, not silence");
  assert.equal(parseQuiet("25-3"), null);
  assert.equal(parseQuiet("nonsense"), null);
});

test("a window that wraps midnight is inside at 23 and at 3, and outside at 9", () => {
  const q = { from: 22, to: 8 };
  assert.equal(inQuiet(23, q), true);
  assert.equal(inQuiet(3, q), true);
  assert.equal(inQuiet(22, q), true);
  assert.equal(inQuiet(8, q), false, "the end hour is exclusive");
  assert.equal(inQuiet(9, q), false);
});

test("an event arriving inside quiet hours is deferred to the end of them, not dropped", () => {
  const at = new Date("2026-09-06T23:30:00.000Z");
  const until = quietDeferral(at, "UTC", { from: 22, to: 8 });
  assert.equal(until, "2026-09-07T08:00:00.000Z");
});

test("an event arriving outside quiet hours is not deferred at all", () => {
  const at = new Date("2026-09-06T12:00:00.000Z");
  assert.equal(quietDeferral(at, "UTC", { from: 22, to: 8 }), null);
  assert.equal(quietDeferral(at, "UTC", null), null, "no quiet hours is never a deferral");
});

test("quiet hours are read in the owner's zone, not the server's", () => {
  /* 23:30 UTC is 09:30 the next morning in Tokyo — awake — and 00:30 in
     Dublin — asleep. The same instant, two answers, which is the whole reason
     the zone is a setting. */
  const at = new Date("2026-09-06T23:30:00.000Z");
  assert.equal(quietDeferral(at, "Asia/Tokyo", { from: 22, to: 8 }), null);
  assert.ok(quietDeferral(at, "Europe/Dublin", { from: 22, to: 8 }));
});

/* --------------------------------------------------- alert reconciliation */

test("an aggregate alert in the same window covers an event; one an hour later does not", () => {
  const trips: AlertTrip[] = [
    { id: 7, ts: "2026-09-06T12:20:00.000Z", skill: "leakage", rule: "Past-due MRR" },
  ];
  assert.equal(coveredBy("2026-09-06T12:00:00.000Z", trips), "alert 7 (Past-due MRR)");
  assert.equal(coveredBy("2026-09-06T09:00:00.000Z", trips), null);
  assert.equal(coveredBy("2026-09-06T12:00:00.000Z", []), null);
});

/* --------------------------------------------------------- case building */

test("a scheduled cancellation opens a churn case with the cancel date as its deadline", () => {
  const { cases, live } = deriveCases({
    accountId: 1,
    accountLabel: "Account 1",
    subscriptions: [sub({ cancel_at_period_end: 1, cancel_at: "2026-10-01T00:00:00.000Z" })],
    openInvoices: [],
    disputes: [],
    ventures: emptyVentures(),
    nowMs: T0,
    horizonDays: 60,
    trialDays: 7,
  });
  assert.equal(cases.length, 1);
  assert.equal(cases[0]!.id, "churn:sub_1");
  assert.equal(cases[0]!.deadline, "2026-10-01T00:00:00.000Z");
  assert.equal(live.has("churn:sub_1"), true);
});

test("an expired checkout is never a case — nobody was ever a customer", () => {
  const { cases } = deriveCases({
    accountId: 1,
    accountLabel: "Account 1",
    subscriptions: [
      sub({
        id: "sub_dead",
        status: "incomplete_expired",
        ended_at: "2026-09-01T00:00:00.000Z",
        paid_cents: 0,
      }),
    ],
    openInvoices: [],
    disputes: [],
    ventures: emptyVentures(),
    nowMs: T0,
    horizonDays: 60,
    trialDays: 7,
  });
  assert.equal(cases.length, 0);
});

test("an open invoice with no attempt behind it is not a failure", () => {
  const invoice = {
    id: "in_1",
    customer: "cus_a",
    customerEmail: null,
    subscription: "sub_1",
    amountDue: 42,
    amountRemaining: 42,
    currency: "usd",
    attemptCount: 0,
    nextPaymentAttempt: null,
    dueDate: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    hostedInvoiceUrl: null,
    number: "A-1",
  };
  const none = deriveCases({
    accountId: 1,
    accountLabel: "Account 1",
    subscriptions: [],
    openInvoices: [invoice],
    disputes: [],
    ventures: emptyVentures(),
    nowMs: T0,
    horizonDays: 60,
    trialDays: 7,
  });
  assert.equal(none.cases.length, 0);

  const one = deriveCases({
    accountId: 1,
    accountLabel: "Account 1",
    subscriptions: [],
    openInvoices: [{ ...invoice, attemptCount: 2, nextPaymentAttempt: "2026-09-09T00:00:00.000Z" }],
    disputes: [],
    ventures: emptyVentures(),
    nowMs: T0,
    horizonDays: 60,
    trialDays: 7,
  });
  assert.equal(one.cases.length, 1);
  assert.equal(one.cases[0]!.id, "payment_failed:in_1");
  assert.equal(one.cases[0]!.deadline, "2026-09-09T00:00:00.000Z");
});

/* ------------------------------------------------------- case resolution */

test("a churn case resolves when Stripe shows the subscription active again", () => {
  const row = caseOf();
  assert.equal(
    resolutionFor(row, { subscription: sub({ cancel_at_period_end: 0, status: "active" }), nowMs: T0 }),
    "Stripe shows the subscription active again with no cancellation scheduled.",
  );
  assert.equal(
    resolutionFor(row, { subscription: sub({ cancel_at_period_end: 1, status: "active" }), nowMs: T0 }),
    null,
    "still scheduled to cancel — nothing has been fixed",
  );
});

test("a churn case for a long-ended subscription closes as not recovered", () => {
  const row = caseOf();
  const long = sub({ status: "canceled", ended_at: new Date(T0 - (ENDED_WINDOW_DAYS + 5) * 86_400_000).toISOString() });
  const reason = resolutionFor(row, { subscription: long, nowMs: T0 });
  assert.ok(reason);
  assert.match(reason!, /was not recovered/);
});

test("a payment case resolves as PAID only when an invoice.paid event was actually seen", () => {
  const row = caseOf({ id: "payment_failed:in_1", kind: "payment_failed", subject_ref: "in_1" });
  assert.equal(resolutionFor(row, { invoiceStillOpen: true, nowMs: T0 }), null);

  const paid = resolutionFor(row, { invoiceStillOpen: false, invoicePaid: true, nowMs: T0 });
  assert.match(paid!, /invoice was paid/);

  const gone = resolutionFor(row, { invoiceStillOpen: false, invoicePaid: false, nowMs: T0 });
  assert.match(gone!, /no longer lists this invoice as open/);
  assert.ok(!/was paid/.test(gone!), "an absence must never be reported as a payment");
});

test("a dispute case resolves on the outcome, and `warning_closed` is not a win", () => {
  const row = caseOf({ id: "dispute:du_1", kind: "dispute", subject_ref: "du_1" });
  const base = {
    id: "du_1",
    account_id: 1,
    account_label: "Account 1",
    charge: "ch_1",
    payment_intent: null,
    amount: 60,
    currency: "usd",
    reason: "fraudulent",
    status: "needs_response",
    evidence_due_by: "2026-09-20T00:00:00.000Z",
    submission_count: 0,
    is_charge_refundable: 1,
    created_at: "2026-09-01T00:00:00.000Z",
    closed_at: null,
    outcome: null,
    venture_id: null,
    seen_at: "2026-09-06T00:00:00.000Z",
  };
  assert.equal(resolutionFor(row, { dispute: base, nowMs: T0 }), null);
  assert.match(
    resolutionFor(row, { dispute: { ...base, status: "won", outcome: "won" }, nowMs: T0 })!,
    /recorded as won/,
  );
  const closed = resolutionFor(row, { dispute: { ...base, status: "warning_closed" }, nowMs: T0 });
  assert.match(closed!, /neither won nor lost/);
});

test("a case that is not this pass's business is left alone", () => {
  assert.equal(resolutionFor(caseOf(), { subscription: null, nowMs: T0 }), null);
});

/* ------------------------------------------------------------- the draft */

test("a draft quotes an absolute date and never promises an action", () => {
  const composed = compose(caseOf());
  assert.ok(composed);
  assert.match(composed!.body, /16 October 2026 \(UTC\)/);
  for (const forbidden of [/will be refunded/i, /we have cancelled/i, /discount/i, /you have been charged/i])
    assert.ok(!forbidden.test(composed!.body), `the body must not contain ${forbidden}`);
  assert.ok(!/https?:\/\//.test(composed!.body), "no link is ever invented");
});

test("an ANNUAL plan's price is never quoted, because the amount is monthly-normalised", () => {
  /* The regression this exists for: the first real draft this area produced
     said "billing at USD 10.21 per year" for a plan whose actual invoice was
     ten times that. `amount` is monthly_usd — a normalisation the dashboard
     performs and the customer has never seen. */
  const annual = caseOf({
    amount: 10.208333,
    context: JSON.stringify({
      state: "cancellation scheduled",
      product: "Widgets",
      cancelAt: "2026-10-16T00:00:00.000Z",
      interval: "year",
      intervalCount: 1,
    }),
  });
  const composed = compose(annual);
  assert.ok(composed);
  assert.ok(!/10\.21|USD/.test(composed!.body), "no price at all on a non-monthly plan");
  assert.equal(composed!.usedFacts.priceQuoted, null);

  const monthly = caseOf({
    amount: 29,
    context: JSON.stringify({
      state: "cancellation scheduled",
      product: "Widgets",
      cancelAt: "2026-10-16T00:00:00.000Z",
      interval: "month",
      intervalCount: 1,
    }),
  });
  const ok = compose(monthly);
  assert.match(ok!.body, /billing at USD 29\.00 a month/);
});

test("there is no draft for a dispute, because the counterparty is a bank", () => {
  assert.equal(compose(caseOf({ id: "dispute:du_1", kind: "dispute" })), null);
});

test("a missing date never becomes a phrase", () => {
  assert.equal(longDate(null), null);
  assert.equal(longDate("not a date"), null);
  const composed = compose(
    caseOf({ deadline: null, context: JSON.stringify({ state: "cancellation scheduled", product: "Widgets" }) }),
  );
  assert.ok(composed);
  assert.ok(!/undefined|null|NaN|Invalid/.test(composed!.body));
});
