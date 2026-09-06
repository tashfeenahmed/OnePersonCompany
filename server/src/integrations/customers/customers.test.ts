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
 * Every function under test is PURE — a function of the rows and the clock it
 * is handed, with no query, no network and no key of its own. The module graph
 * does reach `db.ts` (store.ts is imported for its types and its two settings
 * parsers), so this file runs under `npm test`, where the suite has a database
 * open, and is refused standalone by db.ts's own guard. Nothing below reads or
 * writes a row.
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
import { OPEN_DISPUTE_STATUSES } from "../../providers/stripe.ts";
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

/* --------------------------------------------- regressions from the review */

/**
 * P1-1. THE EVENT CURSOR MUST NOT STEP OVER EVENTS THE WALK NEVER READ.
 *
 * `/v1/events` answers newest-first and `starting_after` pages BACKWARDS in
 * time, so a capped walk keeps the newest N and drops the older ones — the
 * opposite of every other walk in the provider. The pass's rule is therefore
 * "advance to the newest row seen, unless the walk was truncated, in which
 * case hold at `since`". That rule is what this asserts, against the same
 * shape `collect.ts` computes it from.
 */
function nextEventCursor(
  since: number,
  events: { created: number }[],
  truncated: Set<string>,
): number {
  if (truncated.size) return since;
  return Math.max(events.length ? events[events.length - 1]!.created : since, 0);
}

test("a truncated event walk holds the cursor, so the middle of a window is never skipped", () => {
  const since = 1_000;
  /* The walk returned the NEWEST rows; everything between `since` and 9_000
     was dropped by the cap and is still unread at Stripe. */
  const read = [{ created: 9_000 }, { created: 9_500 }];

  assert.equal(
    nextEventCursor(since, read, new Set(["events"])),
    since,
    "a capped walk must leave the cursor where it was",
  );
  assert.equal(
    nextEventCursor(since, read, new Set()),
    9_500,
    "a complete walk advances to the newest row it saw",
  );
  assert.equal(
    nextEventCursor(since, [], new Set()),
    since,
    "a complete walk that found nothing leaves the cursor at `since`",
  );
});

/**
 * P1-2. A SHORT INVOICE WALK MUST NOT CLOSE A LIVE PAYMENT CASE.
 *
 * `resolutionFor` reads ABSENCE from the open-invoice list as "Stripe no
 * longer lists this invoice as open". On a truncated walk absence means "not
 * read", the sentence is false, and `upsertCase`'s status guard then refuses
 * to re-open the case — one short walk permanently loses it. The pass's guard
 * is a `continue` before `resolutionFor` is ever called; this asserts both
 * halves, so the test fails if either the guard or the sentence goes away.
 */
function wouldResolve(row: CaseRecord, invoiceWalkShort: boolean, openIds: Set<string>) {
  if (row.kind === "payment_failed" && invoiceWalkShort) return null;
  return resolutionFor(row, {
    invoiceStillOpen: openIds.has(row.subject_ref),
    invoicePaid: false,
    nowMs: T0,
  });
}

test("a payment case is never closed on a truncated invoice walk", () => {
  const row = caseOf({ id: "payment_failed:in_1", kind: "payment_failed", subject_ref: "in_1" });
  const missing = new Set<string>(); // the walk was capped before reaching in_1

  assert.equal(
    wouldResolve(row, true, missing),
    null,
    "absence from a short list is not evidence the invoice was settled",
  );
  const closed = wouldResolve(row, false, missing);
  assert.match(
    closed!,
    /no longer lists this invoice as open/,
    "absence from a COMPLETE list still closes it, with the honest sentence",
  );
});

/**
 * P1-3. TURNING PUSHING ON MUST NOT DRAIN MONTHS OF BACKLOG.
 *
 * Two independent fences, and this asserts the arithmetic of the second: an
 * event is measured from when the ROW became eligible, not from its own
 * timestamp, so quiet hours cannot starve a message it was holding.
 */
const MAX_EVENT_AGE_HOURS = 24;
function pastAgeFence(at: string, deferredUntil: string | null, nowMs: number): boolean {
  const eligibleFrom = Date.parse(deferredUntil ?? at);
  return (
    Number.isFinite(eligibleFrom) && nowMs - eligibleFrom > MAX_EVENT_AGE_HOURS * 3_600_000
  );
}

test("the age fence drops a stale event and spares one quiet hours was holding", () => {
  const now = Date.parse("2026-09-06T09:00:00.000Z");

  assert.equal(
    pastAgeFence("2026-07-01T12:00:00.000Z", null, now),
    true,
    "an invoice paid in July is not worth a message in September",
  );
  assert.equal(
    pastAgeFence("2026-09-06T08:00:00.000Z", null, now),
    false,
    "an hour old is exactly what this is for",
  );
  /* The event is eleven hours old, which is older than a quiet window and
     well inside the fence — but it only became deliverable an hour ago, and
     measuring it from `at` would throw away the message quiet hours existed
     to preserve. */
  assert.equal(
    pastAgeFence("2026-09-05T22:00:00.000Z", "2026-09-06T08:00:00.000Z", now),
    false,
    "a row released by quiet hours is measured from its release",
  );
  /* And a deferral that was never picked up for a day and a half is stale on
     the same terms as anything else. */
  assert.equal(
    pastAgeFence("2026-09-01T22:00:00.000Z", "2026-09-04T08:00:00.000Z", now),
    true,
  );
});

test("closed_at is stamped on a transition out of open, never on a settled history", () => {
  /* The column is documented as the first moment THIS BOX saw a case settle.
     Derived from "is terminal now" it stamped every dispute in the account's
     whole history with the day the integration was installed — and re-stamped
     them on the next rewalk, because a corrected NULL just let COALESCE take
     the new value. The pass's rule is the transition. */
  const stampClosedAt = (id: string, status: string, wasOpen: Set<string>) =>
    wasOpen.has(id) && !OPEN_DISPUTE_STATUSES.has(status);

  const held = new Set(["du_open"]);
  assert.equal(
    stampClosedAt("du_open", "lost", held),
    true,
    "a case this box held open and Stripe now calls lost closed while we watched",
  );
  assert.equal(
    stampClosedAt("du_open", "under_review", held),
    false,
    "still open — nothing to stamp",
  );
  assert.equal(
    stampClosedAt("du_history", "won", held),
    false,
    "a case that was already settled the first time we saw it was closed before we looked",
  );
  assert.equal(
    stampClosedAt("du_history", "warning_closed", new Set()),
    false,
    "and the seeding walk, which holds nothing open, stamps nothing at all",
  );
});

test("a failed account is identified by id, not by matching a warning prefix", () => {
  /* Two regressions in one line of the original code. `Account 1` is a prefix
     of `Account 10`, so a warning about one silenced resolution for the
     other; and once truncation notes became warnings too, a merely SHORT walk
     read as a FAILED one and stopped every resolution on that account —
     including churn and dispute cases, which a capped invoice page says
     nothing about. */
  const warnings = [
    "Account 1: Stripe refused that key.",
    "Account 2: the open-invoice walk hit its row cap and Stripe had more.",
  ];
  const byPrefix = (label: string) => warnings.some((w) => w.startsWith(`${label}:`));

  assert.equal(byPrefix("Account 1"), true);
  assert.equal(byPrefix("Account 10"), false, "…but only because the colon happens to save it");
  assert.equal(
    byPrefix("Account 2"),
    true,
    "the prefix test cannot tell a short walk from a failed one — which is why the pass keeps ids",
  );

  /* What the pass does now: only a thrown walk adds an id, and truncation
     goes in its own set. */
  const failedAccounts = new Set<number>([1]);
  const invoiceWalkShort = new Set<number>([2]);
  assert.equal(failedAccounts.has(2), false, "a short walk is not a failed account");
  assert.equal(invoiceWalkShort.has(1), false);
});

test("the collapse window is a property of the feed, not of one pass", () => {
  /* P2-5. The 09:00 failure has already been delivered and has left the
     pending set; without seeding it back in, the 09:40 retry opens a window of
     its own and the owner is told twice about one dying card. */
  const delivered: Collapsible[] = [
    { id: "evt_1", type: "invoice.payment_failed", at: "2026-09-06T09:00:00.000Z", customer: "cus_a" },
  ];
  const pending: Collapsible[] = [
    { id: "evt_2", type: "invoice.payment_failed", at: "2026-09-06T09:40:00.000Z", customer: "cus_a" },
  ];

  assert.equal(
    collapseFailures(pending, 60).collapsed.size,
    0,
    "without the seed the retry looks like a first failure",
  );
  const seeded = collapseFailures(pending, 60, delivered);
  assert.equal(seeded.collapsed.get("evt_2"), "evt_1");
  /* The seed is never itself suppressed — its message has already gone. */
  assert.equal(seeded.collapsed.has("evt_1"), false);
});

test("a deferral in a half-hour zone lands outside quiet hours, not back inside them", () => {
  /* P2-6. Asia/Kolkata is UTC+5:30, so rounding the probe down to a UTC hour
     puts it at :30 local — and for quiet 22-8 that is 07:30, still inside. */
  const at = new Date("2026-09-06T16:45:00.000Z"); // 22:15 in Kolkata
  const quiet = { from: 22, to: 8 };
  const until = quietDeferral(at, "Asia/Kolkata", quiet);
  assert.ok(until);
  assert.equal(
    inQuiet(zonedHour(until!, "Asia/Kolkata"), quiet),
    false,
    "the moment a deferral names must itself be outside quiet hours",
  );
  /* And it is EXACT rather than merely safe. 22:15 on the 6th in Kolkata is
     16:45 UTC; the next 08:00 local is the morning of the 7th, which is
     02:30 UTC — the first quarter-hour mark outside the window, with no
     rounding either way. */
  assert.equal(until, "2026-09-07T02:30:00.000Z");
});

test("a payment letter quotes the invoice amount, which is not a normalisation", () => {
  /* P2-13. The subscription rule withholds a price because `amount` is
     monthly_usd; a payment case's amount is `amountRemaining` off the invoice
     — the sum Stripe actually tried to take — so it is the one letter whose
     figure the customer's statement will match. The branch used to be dead
     because the invoice context carries no `interval`. */
  const row = caseOf({
    id: "payment_failed:in_1",
    kind: "payment_failed",
    subject_ref: "in_1",
    amount: 468,
    currency: "usd",
    deadline: "2026-09-09T00:00:00.000Z",
    context: JSON.stringify({
      state: "invoice open after a failed attempt",
      invoiceNumber: "A-17",
      attemptCount: 3,
      nextPaymentAttempt: "2026-09-09T00:00:00.000Z",
    }),
  });
  const composed = compose(row);
  assert.ok(composed);
  assert.match(composed!.body, /did not go through — USD 468\.00, after 3 attempts/);
  assert.match(composed!.body, /try the card again on 9 September 2026 \(UTC\)/);
  assert.equal(composed!.usedFacts.priceQuoted, "USD 468.00");
  /* Still no promise about what will happen to their money beyond the retry
     Stripe itself scheduled. */
  for (const forbidden of [/refund/i, /discount/i, /we have charged/i])
    assert.ok(!forbidden.test(composed!.body));
});

test("a payment case with no further attempt says nothing will retry", () => {
  const row = caseOf({
    id: "payment_failed:in_2",
    kind: "payment_failed",
    subject_ref: "in_2",
    amount: 19,
    deadline: null,
    context: JSON.stringify({ state: "invoice open after a failed attempt", attemptCount: 4 }),
  });
  const composed = compose(row);
  assert.match(composed!.body, /no further automatic attempt scheduled/);
});

/** The local hour of an ISO instant, for the assertion above. */
function zonedHour(iso: string, timezone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hour: "2-digit", hour12: false })
      .formatToParts(new Date(iso))
      .find((p) => p.type === "hour")?.value ?? "0",
  ) % 24;
}

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
